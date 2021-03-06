const zlib = require('zlib')
const partial = require('lodash').partial
const helpers = require('../helpers')

module.exports = function responseBody (middleware, filter) {
  return function (req, res, next) {
    // Apply request filter, if present
    if (filter && !helpers.filterRequest(filter, res)) {
      return next()
    }

    // If body is already present, just continue with it
    if (res.body) {
      return middleware(req, res, next)
    }

    // If connection was closed, stop with explicit error
    if (req.socket.destroyed) {
      return next('connection closed')
    }

    const proto = Object.getPrototypeOf(res)
    var _end = proto.end
    var _write = proto.write
    var _writeHead = proto.writeHead

    var buf = []
    var length = 0
    var closed = false
    var headArgs = null

    // Listen for client connection close
    req.once('close', onClose)

    // Wrap native http methods to intercept
    res.writeHead = function (code, headers) {
      headArgs = helpers.toArray(arguments)
    }

    res.write = function (data) {
      const cb = getCallback(arguments)
      if (isEnded()) return cb && cb()

      if (data) {
        length += +data.length || 0
        buf.push(data)
      }

      if (cb) cb()
    }

    res.end = function (data, encoding) {
      const cb = getCallback(arguments)
      if (isEnded()) return cb && cb()

      if (data && typeof data !== 'function') {
        buf.push(data)
      }

      var body = ''
      try { body = Buffer.concat(buf, length) } catch (e) {}

      // Expose the current body buffer
      res.body = res._originalBody = body

      if (isGzip(res, headArgs)) {
        res.body = inflate(body)
      }

      // Expose the original body encoding
      if (typeof encoding === 'string') {
        res._originalEncoding = encoding
      }

      // Restore native methods
      restore()

      // Trigger response middleware stack
      middleware(req, res, partial(finisher, cb))
    }

    function isEnded () {
      return closed || buf === null
    }

    function onClose () {
      closed = true
      cleanupAndRestore()
    }

    function finisher (cb, err, body, encoding) {
      if (isEnded()) return cb && cb()

      if (err) {
        res.statusCode = +err.status || 500
        return res.end(err.message || err)
      }

      // Write the final body in the stream
      const finalEncoding = encoding || res._originalEncoding
      var finalBody = body || res.body

      if (isGzip(res, headArgs)) {
        finalBody = deflate(finalBody)
      }

      // Set the proper new content length
      if (finalBody && finalBody.length) {
        res.setHeader('content-length', finalBody.length)
      }

      // Write the response head
      if (headArgs && !res.headersSent) {
        res.writeHead.apply(res, headArgs)
      }

      // Write body
      res.write(finalBody, finalEncoding)

      // Be sure we expose the final body in the response
      if (finalBody) res.body = finalBody

      // Clean references to prevent leaks
      cleanup()

      // Send EOF
      res.end(cb)
    }

    function cleanupAndRestore () {
      restore()
      cleanup()
    }

    function restore () {
      res.end = _end
      res.write = _write
      res.writeHead = _writeHead
      _end = _write = _writeHead = null
    }

    function cleanup () {
      buf = length = headArgs = null
      req.removeListener('close', onClose)
    }

    next()
  }
}

function isGzip (res, head) {
  return res.getHeader('content-encoding') === 'gzip' ||
    (head && head[1] && head[1]['content-encoding'] === 'gzip') ||
    false
}

function zlibProxy (fn, body) {
  try {
    return fn(body)
  } catch (e) {
    return body
  }
}

function inflate (body) {
  return zlibProxy(zlib.gunzipSync, body)
}

function deflate (body) {
  return zlibProxy(zlib.gzipSync, body)
}

function getCallback (args) {
  for (var i = 0, l = args.length; i < l; i += 1) {
    if (typeof args[i] === 'function') {
      return args[i]
    }
  }
}
