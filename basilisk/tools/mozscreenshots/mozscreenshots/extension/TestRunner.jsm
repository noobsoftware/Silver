/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["TestRunner"];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
const APPLY_CONFIG_TIMEOUT_MS = 60 * 1000;
const HOME_PAGE = "chrome://mozscreenshots/content/lib/mozscreenshots.html";

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Timer.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/osfile.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "BrowserTestUtils",
                                  "resource://testing-common/BrowserTestUtils.jsm");

Cu.import("chrome://mozscreenshots/content/Screenshot.jsm");

// Create a new instance of the ConsoleAPI so we can control the maxLogLevel with a pref.
// See LOG_LEVELS in Console.jsm. Common examples: "All", "Info", "Warn", & "Error".
const PREF_LOG_LEVEL = "extensions.mozscreenshots@mozilla.org.loglevel";
XPCOMUtils.defineLazyGetter(this, "log", () => {
  let ConsoleAPI = Cu.import("resource://gre/modules/Console.jsm", {}).ConsoleAPI;
  let consoleOptions = {
    maxLogLevel: "info",
    maxLogLevelPref: PREF_LOG_LEVEL,
    prefix: "mozscreenshots",
  };
  return new ConsoleAPI(consoleOptions);
});

this.TestRunner = {
  combos: null,
  completedCombos: 0,
  currentComboIndex: 0,
  _lastCombo: null,
  _libDir: null,

  init(extensionPath) {
    log.debug("init");
    this._extensionPath = extensionPath;
  },

  /**
   * Load specified sets, execute all combinations of them, and capture screenshots.
   */
  start: Task.async(function*(setNames, jobName = null) {
    let subDirs = ["mozscreenshots",
                   (new Date()).toISOString().replace(/:/g, "-") + "_" + Services.appinfo.OS];
    let screenshotPath = FileUtils.getFile("TmpD", subDirs).path;

    const MOZ_UPLOAD_DIR = env.get("MOZ_UPLOAD_DIR");
    if (MOZ_UPLOAD_DIR) {
      screenshotPath = MOZ_UPLOAD_DIR;
    }

    log.info("Saving screenshots to:", screenshotPath);

    let screenshotPrefix = Services.appinfo.appBuildID;
    if (jobName) {
      screenshotPrefix += "-" + jobName;
    }
    screenshotPrefix += "_";
    Screenshot.init(screenshotPath, this._extensionPath, screenshotPrefix);
    this._libDir = this._extensionPath.QueryInterface(Ci.nsIFileURL).file.clone();
    this._libDir.append("chrome");
    this._libDir.append("mozscreenshots");
    this._libDir.append("lib");

    let sets = this.loadSets(setNames);

    log.info(sets.length + " sets:", setNames);
    this.combos = new LazyProduct(sets);
    log.info(this.combos.length + " combinations");

    this.currentComboIndex = this.completedCombos = 0;
    this._lastCombo = null;

    // Setup some prefs
    Services.prefs.setCharPref("browser.aboutHomeSnippets.updateUrl",
                               "data:text/html;charset=utf-8,Generated by mozscreenshots");
    Services.prefs.setCharPref("extensions.ui.lastCategory", "addons://list/extension");
    // Don't let the caret blink since it causes false positives for image diffs
    Services.prefs.setIntPref("ui.caretBlinkTime", -1);

    let browserWindow = Services.wm.getMostRecentWindow("navigator:browser");
    let selectedBrowser = browserWindow.gBrowser.selectedBrowser;
    yield BrowserTestUtils.loadURI(selectedBrowser, HOME_PAGE);
    yield BrowserTestUtils.browserLoaded(selectedBrowser);

    for (let i = 0; i < this.combos.length; i++) {
      this.currentComboIndex = i;
      yield this._performCombo(this.combos.item(this.currentComboIndex));
    }

    log.info("Done: Completed " + this.completedCombos + " out of " +
             this.combos.length + " configurations.");
    this.cleanup();
  }),

  /**
   * Load sets of configurations from JSMs.
   * @param {String[]} setNames - array of set names (e.g. ["Tabs", "WindowSize"].
   * @return {Object[]} Array of sets containing `name` and `configurations` properties.
   */
  loadSets(setNames) {
    let sets = [];
    for (let setName of setNames) {
      try {
        let imported = {};
        Cu.import("chrome://mozscreenshots/content/configurations/" + setName + ".jsm",
                  imported);
        imported[setName].init(this._libDir);
        let configurationNames = Object.keys(imported[setName].configurations);
        if (!configurationNames.length) {
          throw new Error(setName + " has no configurations for this environment");
        }
        for (let config of configurationNames) {
          // Automatically set the name property of the configuration object to
          // its name from the configuration object.
          imported[setName].configurations[config].name = config;
        }
        sets.push(imported[setName].configurations);
      } catch (ex) {
        log.error("Error loading set: " + setName);
        log.error(ex);
        throw ex;
      }
    }
    return sets;
  },

  cleanup() {
    let browserWindow = Services.wm.getMostRecentWindow("navigator:browser");
    let gBrowser = browserWindow.gBrowser;
    while (gBrowser.tabs.length > 1) {
      gBrowser.removeTab(gBrowser.selectedTab, {animate: false});
    }
    gBrowser.unpinTab(gBrowser.selectedTab);
    gBrowser.selectedBrowser.loadURI("data:text/html;charset=utf-8,<h1>Done!");
    browserWindow.restore();
  },

  // helpers

  _performCombo: function*(combo) {
    let paddedComboIndex = padLeft(this.currentComboIndex + 1, String(this.combos.length).length);
    log.info("Combination " + paddedComboIndex + "/" + this.combos.length + ": " +
             this._comboName(combo).substring(1));

    function changeConfig(config) {
      log.debug("calling " + config.name);
      let applyPromise = Promise.resolve(config.applyConfig());
      let timeoutPromise = new Promise((resolve, reject) => {
        setTimeout(reject, APPLY_CONFIG_TIMEOUT_MS, "Timed out");
      });
      log.debug("called " + config.name);
      // Add a default timeout of 500ms to avoid conflicts when configurations
      // try to apply at the same time. e.g WindowSize and TabsInTitlebar
      return Promise.race([applyPromise, timeoutPromise]).then(() => {
        return new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      });
    }

    try {
      // First go through and actually apply all of the configs
      for (let i = 0; i < combo.length; i++) {
        let config = combo[i];
        if (!this._lastCombo || config !== this._lastCombo[i]) {
          log.debug("promising", config.name);
          yield changeConfig(config);
        }
      }

      // Update the lastCombo since it's now been applied regardless of whether it's accepted below.
      log.debug("fulfilled all applyConfig so setting lastCombo.");
      this._lastCombo = combo;

      // Then ask configs if the current setup is valid. We can't can do this in
      // the applyConfig methods of the config since it doesn't know what configs
      // later in the loop will do that may invalidate the combo.
      for (let i = 0; i < combo.length; i++) {
        let config = combo[i];
        // A configuration can specify an optional verifyConfig method to indicate
        // if the current config is valid for a screenshot. This gets called even
        // if the this config was used in the lastCombo since another config may
        // have invalidated it.
        if (config.verifyConfig) {
          log.debug("checking if the combo is valid with", config.name);
          yield config.verifyConfig();
        }
      }
    } catch (ex) {
      log.warn("\tskipped configuration: " + ex);
      // Don't set lastCombo here so that we properly know which configurations
      // need to be applied since the last screenshot

      // Return so we don't take a screenshot.
      return;
    }

    yield this._onConfigurationReady(combo);
  },

  _onConfigurationReady(combo) {
    let delayedScreenshot = () => {
      let filename = padLeft(this.currentComboIndex + 1,
                             String(this.combos.length).length) + this._comboName(combo);
      return Screenshot.captureExternal(filename)
        .then(() => {
          this.completedCombos++;
        });
    };

    log.debug("_onConfigurationReady");
    return Task.spawn(delayedScreenshot);
  },

  _comboName(combo) {
    return combo.reduce(function(a, b) {
      return a + "_" + b.name;
    }, "");
  },
};

/**
 * Helper to lazily compute the Cartesian product of all of the sets of configurations.
 **/
function LazyProduct(sets) {
  /**
   * An entry for each set with the value being:
   * [the number of permutations of the sets with lower index,
   *  the number of items in the set at the index]
   */
  this.sets = sets;
  this.lookupTable = [];
  let combinations = 1;
  for (let i = this.sets.length - 1; i >= 0; i--) {
    let set = this.sets[i];
    let setLength = Object.keys(set).length;
    this.lookupTable[i] = [combinations, setLength];
    combinations *= setLength;
  }
}
LazyProduct.prototype = {
  get length() {
    let last = this.lookupTable[0];
    if (!last)
      return 0;
    return last[0] * last[1];
  },

  item(n) {
    // For set i, get the item from the set with the floored value of
    // (n / the number of permutations of the sets already chosen from) modulo the length of set i
    let result = [];
    for (let i = this.sets.length - 1; i >= 0; i--) {
      let priorCombinations = this.lookupTable[i][0];
      let setLength = this.lookupTable[i][1];
      let keyIndex = Math.floor(n / priorCombinations) % setLength;
      let keys = Object.keys(this.sets[i]);
      result[i] = this.sets[i][keys[keyIndex]];
    }
    return result;
  },
};

function padLeft(number, width, padding = "0") {
  return padding.repeat(Math.max(0, width - String(number).length)) + number;
}
