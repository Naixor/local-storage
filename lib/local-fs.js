'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.noSuchFile = exports.fileExist = undefined;

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _path = require('path');

var _path2 = _interopRequireDefault(_path);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _mkdirp = require('mkdirp');

var _mkdirp2 = _interopRequireDefault(_mkdirp);

var _httpErrors = require('http-errors');

var _httpErrors2 = _interopRequireDefault(_httpErrors);

var _streams = require('@verdaccio/streams');

var _fileLocking = require('@verdaccio/file-locking');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const fileExist = exports.fileExist = 'EEXISTS';

const noSuchFile = exports.noSuchFile = 'ENOENT';

const resourceNotAvailable = 'EAGAIN';
const pkgFileName = 'package.json';
const fSError = function fSError(message, code = 409) {
  const err = (0, _httpErrors2.default)(code, message);
  // $FlowFixMe
  err.code = message;

  return err;
};

const ErrorCode = {
  get503: () => {
    return fSError('resource temporarily unavailable', 500);
  },
  get404: customMessage => {
    return fSError('no such package available', 404);
  }
};

const tempFile = function tempFile(str) {
  return `${str}.tmp${String(Math.random()).substr(2)}`;
};

const renameTmp = function renameTmp(src, dst, _cb) {
  const cb = err => {
    if (err) {
      _fs2.default.unlink(src, function () {});
    }
    _cb(err);
  };

  if (process.platform !== 'win32') {
    return _fs2.default.rename(src, dst, cb);
  }

  // windows can't remove opened file,
  // but it seem to be able to rename it
  const tmp = tempFile(dst);
  _fs2.default.rename(dst, tmp, function (err) {
    _fs2.default.rename(src, dst, cb);
    if (!err) {
      _fs2.default.unlink(tmp, () => {});
    }
  });
};

class LocalFS {

  constructor(path, logger) {
    this.path = path;
    this.logger = logger;
  }

  /**
   *  This function allows to update the package thread-safely
     Algorithm:
     1. lock package.json for writing
     2. read package.json
     3. updateFn(pkg, cb), and wait for cb
     4. write package.json.tmp
     5. move package.json.tmp package.json
     6. callback(err?)
   * @param {*} name
   * @param {*} updateHandler
   * @param {*} onWrite
   * @param {*} transformPackage
   * @param {*} onEnd
   */
  updatePackage(name, updateHandler, onWrite, transformPackage, onEnd) {
    this._lockAndReadJSON(pkgFileName, (err, json) => {
      let locked = false;
      const self = this;
      // callback that cleans up lock first
      const unLockCallback = function unLockCallback(lockError) {
        let _args = arguments;
        if (locked) {
          self._unlockJSON(pkgFileName, function () {
            // ignore any error from the unlock
            onEnd.apply(lockError, _args);
          });
        } else {
          onEnd(..._args);
        }
      };

      if (!err) {
        locked = true;
      }

      if (_lodash2.default.isNil(err) === false) {
        if (err.code === resourceNotAvailable) {
          return unLockCallback(ErrorCode.get503());
        } else if (err.code === noSuchFile) {
          return unLockCallback(ErrorCode.get404());
        } else {
          return unLockCallback(err);
        }
      }

      updateHandler(json, err => {
        if (err) {
          return unLockCallback(err);
        }
        onWrite(name, transformPackage(json), unLockCallback);
      });
    });
  }

  deletePackage(fileName, callback) {
    return _fs2.default.unlink(this._getStorage(fileName), callback);
  }

  removePackage(callback) {
    _fs2.default.rmdir(this._getStorage('.'), callback);
  }

  createPackage(name, value, cb) {
    this._createFile(this._getStorage(pkgFileName), this._convertToString(value), cb);
  }

  savePackage(name, value, cb) {
    this._writeFile(this._getStorage(pkgFileName), this._convertToString(value), cb);
  }

  readPackage(name, cb) {
    this._readStorageFile(this._getStorage(pkgFileName)).then(function (res) {
      try {
        const data = JSON.parse(res.toString('utf8'));

        cb(null, data);
      } catch (err) {
        cb(err);
      }
    }, function (err) {
      return cb(err);
    });
  }

  writeTarball(name) {
    const uploadStream = new _streams.UploadTarball();

    let _ended = 0;
    uploadStream.on('end', function () {
      _ended = 1;
    });

    const pathName = this._getStorage(name);

    _fs2.default.exists(pathName, exists => {
      if (exists) {
        uploadStream.emit('error', fSError(fileExist));
      }

      const temporalName = _path2.default.join(this.path, `${pathName}.tmp-${String(Math.random()).replace(/^0\./, '')}`);
      const file = _fs2.default.createWriteStream(temporalName);
      const removeTempFile = () => _fs2.default.unlink(temporalName, function () {});
      let opened = false;
      uploadStream.pipe(file);

      uploadStream.done = function () {
        const onend = function onend() {
          file.on('close', function () {
            renameTmp(temporalName, pathName, function (err) {
              if (err) {
                uploadStream.emit('error', err);
              } else {
                uploadStream.emit('success');
              }
            });
          });
          file.end();
        };
        if (_ended) {
          onend();
        } else {
          uploadStream.on('end', onend);
        }
      };

      uploadStream.abort = function () {
        if (opened) {
          opened = false;
          file.on('close', function () {
            removeTempFile();
          });
        } else {
          // if the file does not recieve any byte never is opened and has to be removed anyway.
          removeTempFile();
        }
        file.end();
      };

      file.on('open', function () {
        opened = true;
        // re-emitting open because it's handled in storage.js
        uploadStream.emit('open');
      });

      file.on('error', function (err) {
        uploadStream.emit('error', err);
      });
    });

    return uploadStream;
  }

  readTarball(name, readTarballStream, callback = () => {}) {
    const pathName = this._getStorage(name);

    const readStream = _fs2.default.createReadStream(pathName);

    readStream.on('error', function (err) {
      readTarballStream.emit('error', err);
    });

    readStream.on('open', function (fd) {
      _fs2.default.fstat(fd, function (err, stats) {
        if (_lodash2.default.isNil(err) === false) {
          return readTarballStream.emit('error', err);
        }
        readTarballStream.emit('content-length', stats.size);
        readTarballStream.emit('open');
        readStream.pipe(readTarballStream);
      });
    });

    readTarballStream = new _streams.ReadTarball();

    readTarballStream.abort = function () {
      readStream.close();
    };

    return readTarballStream;
  }

  _createFile(name, contents, callback) {
    _fs2.default.exists(name, exists => {
      if (exists) {
        return callback(fSError(fileExist));
      }
      this._writeFile(name, contents, callback);
    });
  }

  _readStorageFile(name) {
    return new Promise((resolve, reject) => {
      _fs2.default.readFile(name, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  _convertToString(value) {
    return JSON.stringify(value, null, '\t');
  }

  _getStorage(name = '') {
    const storagePath = _path2.default.join(this.path, name);

    return storagePath;
  }

  _writeFile(dest, data, cb) {
    const createTempFile = cb => {
      const tempFilePath = tempFile(dest);

      _fs2.default.writeFile(tempFilePath, data, err => {
        if (err) {
          return cb(err);
        }
        renameTmp(tempFilePath, dest, cb);
      });
    };

    createTempFile(err => {
      if (err && err.code === noSuchFile) {
        (0, _mkdirp2.default)(_path2.default.dirname(dest), function (err) {
          if (err) {
            return cb(err);
          }
          createTempFile(cb);
        });
      } else {
        cb(err);
      }
    });
  }

  _lockAndReadJSON(name, cb) {
    const fileName = this._getStorage(name);

    (0, _fileLocking.readFile)(fileName, {
      lock: true,
      parse: true
    }, function (err, res) {
      if (err) {
        return cb(err);
      }
      return cb(null, res);
    });
  }

  _unlockJSON(name, cb) {
    (0, _fileLocking.unlockFile)(this._getStorage(name), cb);
  }

}

exports.default = LocalFS;