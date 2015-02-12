var hashish = require('hashish');
var fs      = require('fs');
var findit  = require('findit');
var path    = require('path');
var http    = require('http');
var net     = require('net');
var assert  = require('assert');
var request = require('request');
var async   = require('async');

var common     = require('../common');
var formidable = common.formidable;

var gotAborted  = false;
var filesParsed = 0;

function MultiFileTester() {
  this._server       = null;
  this._fixtures     = [];
  this._fixtureSizes = 0;
  this._boundary     = Math.random();
}

MultiFileTester.prototype.run = function(cb) {
  async.series([
    this._createServer.bind(this),
    this._bindRequestEvent.bind(this),
    this._findFixtures.bind(this),
    this._calcFixtureFileSizes.bind(this),
    this._runRequest.bind(this),
    this._endServer.bind(this)
  ], cb);

};

MultiFileTester.prototype._createServer = function(cb) {
  this._server = http.createServer();
  this._server.listen(common.port, cb);
};

MultiFileTester.prototype._endServer = function(cb) {
  this._server.close();
  cb();
};

MultiFileTester.prototype._bindRequestEvent = function(cb) {
  this._server.once('request', function(req, res) {
    console.log('new request');

    var form = new formidable.IncomingForm();
    form.uploadDir = common.dir.tmp;
    form.hash = "sha1";
    form.parse(req);
    form.multiples = true;
    form.keepExtensions = true;

    form
      .on('error', function(err) {
        console.log("FORM ERROR", err);
      })
      .on('file', function(a, b) {
        filesParsed++;
      })
      .on('aborted', function() {
        gotAborted = true;
      })
      .on('end', function() {
        res.end('OK');
      });
  });

  cb();
};

MultiFileTester.prototype._findFixtures = function(cb) {
  var self = this;

  this._fixtures = findit.sync(common.dir.fixture + '/file/aborted_test');

  cb();
};

MultiFileTester.prototype._calcFixtureFileSizes = function(cb) {
  var sizes = 0;

  function calcSize(filePath, innerCb) {
    fs.stat(filePath, function(err, stat) {
      if (err) {
        return innerCb(err);
      }

      sizes += stat.size;
      innerCb();
    });
  }

  var self = this;
  var queue = async.queue(calcSize, 5);
  queue.drain = function() {
    self._fixtureSizes = sizes;
    cb();
  };

  queue.push(this._fixtures);
};

MultiFileTester.prototype._makeReq = function(opts, cb) {
  var req = http.request(opts, function(res) {
    res.setEncoding("utf8");

    var response = "";
    res.on("data", function(chunk) {
      response += chunk;
    });

    res.on("end", function() {
      cb(null, response);
    });
  });

  // overwrite req.write for some logging fun
  var originalWrite = req.write;
  req.write = function(data) {
    // console.log(data);
    originalWrite.apply(req, arguments);
  };

  req.on("error", function(err) {
    cb(err);
  });

  return req;
};

MultiFileTester.prototype._runRequest = function(cb) {
  var fileStart = [];
  fileStart.push("--" + this._boundary);
  fileStart.push("Content-Type: text/plain");
  fileStart.push("Content-Disposition: form-data; name=\"my_file####\"; filename=\"my_file####\"");
  fileStart.push("Content-Transfer-Encoding: binary");
  fileStart.push("\r\n");

  var fileStartStr = fileStart.join("\r\n");
  var tail = "\r\n--" + this._boundary + "--\r\n";
  var fileEndStr = "\r\n";

  var len = this._fixtureSizes + this._fixtures.length * (fileStartStr.length + fileEndStr.length) + tail.length;

  var opts = {
    host    : "localhost",
    port    : common.port,
    path    : "/",
    method  : "POST",
    headers : {
      "Content-Type"   : "multipart/form-data; boundary=" + this._boundary,
      "Content-Length" : len,
      Connection       : "close"
    }
  };

  // our cb is used here
  var req = this._makeReq(opts, cb);

  var fileNum = 1000;
  var content = "";

  function addFile(filePath, innerCb) {
    var stream = fs.createReadStream(filePath, {end: false});

    fileNum++;
    var strToUse = fileStartStr.replace(/####/g, fileNum);
    req.write(strToUse);

    stream.on("end", function() {
      req.write(fileEndStr);
      innerCb();
    });
    stream.pipe(req, {end: false});
  }

  var queue = async.queue(addFile, 1);
  queue.drain = function() {
    req.write(tail);
  };

  queue.push(this._fixtures);
};

var tester = new MultiFileTester();
tester.run(function(err) {
  if (err) {
    throw err;
  }

  assert.equal(filesParsed, 143);
  assert.ok(gotAborted);
});
