var fs = require('fs')
  , path = require('path')
  , url = require('url')
  , crypto = require('crypto')
  , cluster = require('cluster');

var async = require('async')
  , mkdirp = require('mkdirp')
  , cheerio = require('cheerio')
  , glob = require('glob')
  , request = require('request')

  , rimraf = require('rimraf')
  , _ = require('lodash')

  , E = require('../utils/E.js')
  , log = require('../utils/log.js')
  , file = require('../utils/file.js')
  , tell = require('../utils/tell.js')
  , fingerprint = require('../utils/fingerprint.js')
  , wwwHelpers = require('../utils/www-helpers.js');

// request.debug = true;

var Fancy = require('../fancy/index.js');
var helpers = require('../fancy/helpers/index.js');
var workers = require('./workers.js');

function Compile(options, done) {
  options.concurrency = Math.max(0, (options.concurrency || 0) - 1); // workaround to hackish way cluster is added
  this.isMaster = !options.concurrency || cluster.isMaster;
  console.log('Fancy Options: ', options);
  this.fancy = new Fancy(options);
  this.done = done || function(){
    console.log('Done!');
    process.exit();
  };

  this.host = 'localhost';
  this.destinationRoot = 'dist';
  this.destination = this.destinationRoot + '/compiled';

  this.queue = null;
  this.workers = 1;
  this.knownRoutes = [];

  this.index = {};
}

// Compile.prototype.start = function(callback) {
//   var _this = this;

//   mkdirp.sync(_this.destination);
//   workers.endpoint = this.host + ':' + this.fancy.options.port;

//   if (_this.isMaster) {
//     _this.queue = async.queue(function(route, taskCallback) {
//       _this.addResource(route, request('http://localhost:3000' + route), taskCallback);
//     }, _this.workers);
//     _this.queue.drain = function() {
//       fs.writeFileSync(path.join(_this.destination, 'index.json'), JSON.stringify(_this.index, null, 2));
//       _this.done.apply(this, arguments);
//     };
//   }

//   _this.fancy.init(function(err) {
//     if (err) return callback(err);
//     // delay start until really, truly init
//     setTimeout(function() {
//       _this.onReady();
//       callback(null);
//     }, 1000);
//   });

//   // async.parallel([
//       // TODO: support multiple content directories
//   // var matches = glob('./data/content/**/*.html/public');
//   // for (var i=0; i < matches.length; i++) {
//   //   app.use(express.static(path.join(process.cwd(), matches[i])));
//   // }

//   // ], function() {

//   // });
// };

Compile.prototype.start = function(callback) {
  var _this = this;
  this.fancy.init(function(err) {
    if (err) return callback(err);
    // delay start until really, truly init
    setTimeout(function() {
      log.debug('fancy init complete; calling ready');
      _this.onReady(callback);
    }, 1000);
  });
};

Compile.prototype.onReady = function(callback) {
  var _this = this;
  var logger = log.child({ component: 'compiler' });
  callback = E.timeout(callback || function(err){ if (err) throw err; });
  options = {
    content: 'content',
    assets: 'assets',
    target: 'dist',
    port: 3000,
    assetExtensions: ['png','gif','jpg','ico'],
  };
  var destinationAssetsPath = file.abs(path.join(options.target, 'assets'));
  var dbPort = options.port + 100;

  log.debug('on ready options', options);

  function moveAsset(src, dest, callback) {
    var destDir = path.dirname(dest)
      , _logger = logger.child({ source: src, destination: dest });
    fs.exists(dest, function(yes) {
      if (yes) {
        _logger.trace({ exists: yes }, 'skipping');
        callback();
      }
      else {
        _logger.trace({ directory: destDir }, 'mkdirp');
        mkdirp(destDir, E.bubbles(callback, function() {
          var copy = fs.createReadStream(src)
            .on('error', E.event(callback))
            .pipe(fs.createWriteStream(dest))
            .on('error', E.event(callback))
            .on('finish', callback);
          _logger.trace({ source: src, destination: dest }, 'copying');
        }));
      }
    });
  }

  function removeExpiredFiles(dest, dictionary) {
    var keys = Object.keys(dictionary)
      , compiled = fs.readdirSync(dest);

    logger.debug({ directory: dest }, 'removing expired assets');

    for (var i=0; i < compiled.length;i ++) {
      var item = compiled[i]
        , f = path.join(dest, item);
      if (item !== 'index.json' && fs.statSync(f).isFile() && keys.indexOf(item) < 0) {
        logger.trace({ path: f, target: item }, 'removing expired asset');
        fs.unlinkSync(f);
      }
    }

    // TODO: remove expired assets.  for now they're just recreated every compile (slow)
  }

  log.debug('Starting compiler...');

  mkdirp.sync(destinationAssetsPath);

  log.debug('Destination confirmed: %s', options.target);

  var dictionary = {};
  var endpoint = 'http://localhost:' + options.port;

  log.debug('Endpoint: %s', endpoint);

  var themePath = file.abs('./' + (options.theme ? 'themes/' + options.theme : 'theme'));
  var themeAssets = file.abs(path.join(themePath, 'public'));
  var dataAssets = file.abs('./data/' + options.assets);
  var contentAssets = glob.sync(file.abs('./data/' + options.content + '/**/*.html/public'));
  var assetPaths = [themeAssets, dataAssets].concat(contentAssets);

  logger.info({ list: assetPaths }, 'gather assets');
  var allAssets = wwwHelpers.gatherAssets(assetPaths, options.assetExtensions, themeAssets);
  logger.trace({ list: allAssets.map(function(element) { return element.abs; }) }, 'assets found');

  // FIXME: only remove the expired files and not the whole directory.  see removeExpiredFiles TODO above
  logger.info({ target: destinationAssetsPath }, 'cleaning up compiled assets');
  rimraf(destinationAssetsPath, E.bubbles(callback, function(err) {
    if (allAssets.length) {
      var uniqueAssets = _.where(allAssets, { collision: false })
        , assetMoveTasks = uniqueAssets.map(function(element) {
            return async.apply(moveAsset, element.abs, path.join(destinationAssetsPath, element.rel));
          });
      async.parallelLimit(assetMoveTasks, 32, E.bubbles(callback, function() {
        logger.info({ list: _.pluck(uniqueAssets, 'abs'), destination: destinationAssetsPath }, 'assets moved');
      }));
    }
  }));

  var urls = [];
  (_this.fancy.options.buildRoutes || []).forEach(_this.enqueueUrl);

  for (var relativePath in _this.fancy.db.pages) {
    var page = _this.fancy.db.pages[relativePath];
    var utils = helpers({}, _this.fancy);
    if (false === page.getProperty('compile')) { // if compile set to false, don't include it in compilation
      console.log('Skipping file (marked no compile): ', relativePath);
    }
    else {
      console.log('Enqueue file: ', relativePath);
      urls.push(utils.relative(null, page.toTemplateObject()));
    }
  }

  log.debug('Retrieved %s urls', urls.length);

  // TODO: conditional recompile. load index.json and compare compiled value against last revision

  var alreadyCrawled = [];
  var q = async.queue(function(task, queueCallback) {
    if (alreadyCrawled.indexOf(task.url) > -1) {
      logger.trace({ url: task.url }, 'skipping, already crawled');
      return queueCallback(null);
    }
    alreadyCrawled.push(task.url);
    var hashName = fingerprint.sync(task.url)
      , destination = path.join(options.target, hashName);
    var result = dictionary[hashName] = {
        url: task.url
      , status: -1
      , fingerprint: null
      , location: null
    };
    log.debug('\t-> Processing "%s" and writing to %s', task.url, destination);
    // TODO: if strict and non-200 status returned, error
    request.get(endpoint + task.url)
      .on('response', function(res) {
        result.fingerprint = res.headers['etag'];
        result.location = res.headers['location'];
        result.compiled = res.headers['fancy-compiled']; // used with conditional recompile
        result.status = res.statusCode;
      })
      .pipe(fs.createWriteStream(destination))
        .on('error', E.event(queueCallback))
        .on('finish', queueCallback);
  }, 24);

  var _routeDiscovered = this.fancy.routeDiscovered;
  this.fancy.routeDiscovered = function(url) {
    var ret = _routeDiscovered.apply(this, arguments);
    if (ret) {
      console.log('Enqueue file (discovered): ', relativePath);
      q.push({ url: url });
    }
    return ret;
  }

  // TODO: get yield urls and append to end of queue
  // TODO: get other extraneous features like redirects, aliased routes and other stuff

  q.drain = function() {
    log.debug('Writing index...');
    fs.writeFileSync(path.join(options.target, 'index.json'), JSON.stringify(dictionary, null, 2));
    removeExpiredFiles(options.target, dictionary);
    log.debug('Done!');
    callback();
  };

  urls.forEach(function(pendingUrl, index) {
    logger.trace({ url: pendingUrl, index: index }, 'url queue -> data');
    q.push({ url: pendingUrl });
  });
};

// Compile.prototype.onReady = function() {
//   var _this = this;
//   console.log('Compile ready %s', process.pid);
//   (_this.fancy.options.buildRoutes || []).forEach(_this.enqueueUrl);

//   for (var relativePath in _this.fancy.db.pages) {
//     var page = _this.fancy.db.pages[relativePath];
//     var utils = helpers({}, _this.fancy);
//     if (false === page.getProperty('compile')) { // if compile set to false, don't include it in compilation
//       console.log('Skipping file (marked no compile): ', relativePath);
//     }
//     else {
//       console.log('Enqueue file: ', relativePath);
//       _this.enqueueUrl(utils.relative(null, page.toTemplateObject()));
//     }
//   }


//   // rimraf('./dist', function() {
//   //   mkdirp.sync('./dist');
//   //   // ncp('./themes/blah/public/', './dist', function (err) {
//   //   //  if (err) {
//   //   //    return console.error(err);
//   //   //  }
//   //   //  console.log('done!');
//   //   // });
//   //   process.exit(0);
//   // });
// };

Compile.prototype.enqueueUrl = function(route) {
  var _this = this;
  if (_this.isMaster && _this.knownRoutes.indexOf(route) < 0) {
    console.log('<- Discovered: %s', route);
    _this.queue.push(route);
    // request('http://localhost:3000' + task.route).pipe(writable);
  }
};

Compile.prototype.addResource = function(route, contents, callback) {
  if (!route) {
    console.log('Invalid route passed: "%s"', route);
  }
  var hash = crypto.createHash('sha1').update(route || '').digest('hex');
  this.index[hash] = route;
  var writable = fs.createWriteStream(path.join(this.destination, hash));
  contents.pipe(writable);
  contents.on('end', callback);
};

// Compile.prototype.getWritable = function(route) {
//   var f = (route || '').toLowerCase().trim().replace(/[^\w\d]+/g, '-').replace(/\-\-+/g, '-').replace(/^\-+|\-+$/, '') + '.html';
//   return fs.createWriteStream(path.join(this.destination, f));
// };

module.exports = Compile;
