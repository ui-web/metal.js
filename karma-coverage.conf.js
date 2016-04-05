'use strict';

var metalKarmaConfig = require('metal-karma-config/coverage');

module.exports = function (config) {
  metalKarmaConfig(config);
  delete config.preprocessors['src/**/!(*.soy).js'];
  config.preprocessors['src/incremental-dom.js'] = ['babel', 'commonjs'];
  config.preprocessors['src/**/!(incremental-dom).js'] = ['coverage', 'commonjs'];
};
