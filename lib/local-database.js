'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _path = require('path');

var _path2 = _interopRequireDefault(_path);

var _localFs = require('./local-fs');

var _localFs2 = _interopRequireDefault(_localFs);

var _mkdirp = require('mkdirp');

var _mkdirp2 = _interopRequireDefault(_mkdirp);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/**
 * Handle local database.
 */
class LocalDatabase {

  /**
   * Load an parse the local json database.
   * @param {*} path the database path
   */
  constructor(config, logger) {
    this.config = config;
    this.path = this._buildStoragePath(config);
    this.logger = logger;
    this.locked = false;
    this.data = this._fetchLocalPackages();
    this.data.secret = this.config.checkSecretKey(this.data.secret);
    this.sync();
  }

  /**
   * Add a new element.
   * @param {*} name
   * @return {Error|*}
   */
  add(name) {
    if (this.data.list.indexOf(name) === -1) {
      this.data.list.push(name);
      return this.sync();
    }
  }

  /**
   * Remove an element from the database.
   * @param {*} name
   * @return {Error|*}
   */
  remove(name) {
    const pkgName = this.get().indexOf(name);
    if (pkgName !== -1) {
      this.data.list.splice(pkgName, 1);
    }

    return this.sync();
  }

  /**
   * Return all database elements.
   * @return {Array}
   */
  get() {
    return this.data.list;
  }

  /**
   * Syncronize {create} database whether does not exist.
   * @return {Error|*}
   */
  sync() {
    if (this.locked) {
      this.logger.error('Database is locked, please check error message printed during startup to prevent data loss.');
      return new Error('Verdaccio database is locked, please contact your administrator to checkout logs during verdaccio startup.');
    }
    // Uses sync to prevent ugly race condition
    try {
      _mkdirp2.default.sync(_path2.default.dirname(this.path));
    } catch (err) {
      // perhaps a logger instance?
      /* eslint no-empty:off */
    }

    try {
      _fs2.default.writeFileSync(this.path, JSON.stringify(this.data));
    } catch (err) {
      return err;
    }
  }

  getPackageStorage(packageInfo) {
    // $FlowFixMe
    const packagePath = this._getLocalStoragePath(this.config.getMatchedPackagesSpec(packageInfo).storage);

    if (_lodash2.default.isString(packagePath) === false) {
      this.logger.debug({ name: packageInfo }, 'this package has no storage defined: @{name}');
      return;
    }

    const packageStoragePath = _path2.default.join(_path2.default.resolve(_path2.default.dirname(this.config.self_path || ''), packagePath), packageInfo);

    return new _localFs2.default(packageStoragePath, this.logger);
  }

  /**
   * Verify the right local storage location.
   * @param {String} path
   * @return {String}
   * @private
   */
  _getLocalStoragePath(path) {
    if (_lodash2.default.isNil(path) === false) {
      return path;
    }

    return this.config.storage;
  }

  /**
   * Build the local database path.
   * @param {Object} config
   * @return {string|String|*}
   * @private
   */
  _buildStoragePath(config) {
    // FUTURE: the database might be parameterizable from config.yaml
    return _path2.default.join(_path2.default.resolve(_path2.default.dirname(config.self_path || ''), config.storage, '.sinopia-db.json'));
  }

  /**
   * Fetch local packages.
   * @private
   * @return {Object}
   */
  _fetchLocalPackages() {
    const database = [];
    const emptyDatabase = { list: database, secret: '' };

    try {
      const dbFile = _fs2.default.readFileSync(this.path, 'utf8');

      if (_lodash2.default.isNil(dbFile)) {
        // readFileSync is platform specific, FreeBSD might return null
        return emptyDatabase;
      }

      const db = this._parseDatabase(dbFile);

      if (!db) {
        return emptyDatabase;
      }

      return db;
    } catch (err) {
      // readFileSync is platform specific, macOS, Linux and Windows thrown an error
      // Only recreate if file not found to prevent data loss
      if (err.code !== 'ENOENT') {
        this.locked = true;
        this.logger.error('Failed to read package database file, please check the error printed below:\n', `File Path: ${this.path}\n\n ${err.message}`);
      }
      return emptyDatabase;
    }
  }

  /**
   * Parse the local database.
   * @param {Object} dbFile
   * @private
   * @return {Object}
   */
  _parseDatabase(dbFile) {
    try {
      return JSON.parse(dbFile);
    } catch (err) {
      this.logger.error(`Package database file corrupted (invalid JSON), please check the error printed below.\nFile Path: ${this.path}`, err);
      this.locked = true;
    }
  }

}

exports.default = LocalDatabase;