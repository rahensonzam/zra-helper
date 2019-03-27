const path = require('path');
const fs = require('fs');
// eslint-disable-next-line import/no-extraneous-dependencies
const webpack = require('webpack');
const packageJson = require('./package.json');

const contentScriptEntries = {};

function addContentScripts(folder) {
  const contentScriptsPath = path.join('src/backend/content_scripts', folder);
  const contentScripts = fs.readdirSync(contentScriptsPath);
  for (const file of contentScripts) {
    const ext = path.extname(file);
    if (ext === '.ts') {
      const filename = path.basename(file, ext);
      const outputPath = path.join('content_scripts', folder, filename);
      contentScriptEntries[outputPath] = path.join(contentScriptsPath, file);
    }
  }
}

addContentScripts('commands');
addContentScripts('pages');

const copy = [
  {
    from: 'LICENSE.txt',
    to: '',
  },
  {
    from: 'src/assets/fonts/nunito-license.txt',
    to: 'fonts/',
  },
];

const browser = process.env.BROWSER ? process.env.BROWSER : 'chrome';

const hotReloadEnabled = process.env.HOT_RELOAD === 'enabled';

const webpackPlugins = [];

if (hotReloadEnabled) {
  webpackPlugins.push(new webpack.ProvidePlugin({
    browser: 'sinon-chrome/webextensions',
    chrome: 'sinon-chrome/extensions',
  }));
}

module.exports = {
  lintOnSave: false,
  productionSourceMap: false,
  configureWebpack: {
    node: {
      // OCRAD.js expects global to be defined.
      global: true,
    },
    plugins: webpackPlugins,
  },
  chainWebpack: (config) => {
    config
      .plugin('copy')
      .tap((args) => {
        const paths = args[0] || [];
        return [paths.concat(copy)];
      });
    config.resolve.alias.set('styles', path.resolve(__dirname, './src/assets/scss'));
    config.resolve.alias.set('$tests', path.resolve(__dirname, './tests'));

    config
      .plugin('define')
      .tap((args) => {
        args[0]['process.env'].BROWSER = `"${browser}"`;
        args[0]['process.env'].HOT_RELOAD = `"${process.env.HOT_RELOAD}"`;
        return args;
      });

    config.module
      .rule('vue')
      .use('vue-loader')
      .loader('vue-loader')
      .tap((options) => {
        if (!hotReloadEnabled) {
          options.hotReload = false;
        }
        // Disable prettier to decrease compile time
        // See https://github.com/vuejs/vue-loader/issues/1426
        options.prettify = false;
        return options;
      });
    if (!hotReloadEnabled) {
      if (config.plugins.has('hmr')) {
        config.plugins.delete('hmr');
      }
    }

    // Hide 'bufferutil' and 'utf-8-validate' module not found errors.
    // See https://github.com/websockets/ws/issues/1220
    config.externals(['bufferutil', 'utf-8-validate']);
  },
  pages: {
    dashboard: {
      entry: 'src/main.ts',
      filename: 'app.html',
      title: 'ZRA Helper',
    },
    options: {
      entry: 'src/options/options.ts',
      filename: 'options.html',
      title: 'Options',
    },
  },
  pluginOptions: {
    browserExtension: {
      components: {
        background: true,
        contentScripts: true,
        options: true,
      },
      api: 'browser',
      usePolyfill: !hotReloadEnabled,
      autoImportPolyfill: !hotReloadEnabled,
      componentOptions: {
        background: {
          entry: 'src/backend/background.ts',
        },
        contentScripts: {
          entries: contentScriptEntries,
        },
      },
      manifestSync: ['description'],
      outputDir: `dist/${browser}`,
      manifestTransformer(originalManifest) {
        const manifest = Object.assign({}, originalManifest);
        if (browser === 'firefox') {
          // Remove pageCapture permission in Firefox
          const index = manifest.permissions.indexOf('pageCapture');
          manifest.permissions.splice(index, 1);
        } else if (browser === 'chrome') {
          delete manifest.applications;
        }

        const fullVersion = packageJson.version;
        const numericVersion = fullVersion.split('-')[0];
        manifest.version = numericVersion;

        // Firefox doesn't support the 'version_name' key
        if (browser === 'chrome') {
          manifest.version_name = fullVersion;
        }

        return manifest;
      },
    },
  },
  outputDir: `dist/${browser}`,
};
