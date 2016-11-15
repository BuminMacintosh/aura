/*
 * Copyright (C) 2013 salesforce.com, inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * DomHandlersPlugin
 * =================
 * This plugin hooks into the definition of aura:html component.
 * In particular the following methods:
 * dispatchAction(): Tracks all interactions (click, mouseovers, any DOM handlers) 
 * handled by any active component
 *
 * @description DomHandlersPlugin
 * @constructor
 * @export
 */
var DomHandlersPlugin = function DomHandlersPlugin(config) {
    this.config = config;
    this["enabled"] = true;
};

DomHandlersPlugin.NAME = "domHandlers";
DomHandlersPlugin.DEFAULT_INTERACTION_TYPE = "user";
DomHandlersPlugin.WHITELISTEVENTS = { 
    "click"  : true,
    "change" : true
};

/** @export */
DomHandlersPlugin.prototype.initialize = function (metricsService) {
    this.metricsService = metricsService;

    if (this["enabled"]) {
        this.bind();
    }
};

/** @export */
DomHandlersPlugin.prototype.enable = function () {
    if (!this["enabled"]) {
        this["enabled"] = true;
        this.bind();
    }
};

/** @export */
DomHandlersPlugin.prototype.disable = function () {
    if (this["enabled"]) {
        this["enabled"] = false;
        this.unbind(this.metricsService);
    }
};

/*
// We might need this method somewhere in the future

DomHandlersPlugin.prototype.stringifyLocator = function (locator) {
    var ordered = { 
        target  : locator.target, 
        scope   : locator.scope, 
        context : locator.context && Object.keys(locator.context).sort().reduce(function (r, k) { r[k] = locator.context[k]; return r; }, {}) 
    };

    if (!locator.context) {
        delete locator.context;
    }
    
    return JSON.stringify(ordered);
};
*/

/**
 * Logs LightningInteraction transactions if the html event handled is in the whitelist
 * 
 * @param action - This is unused
 * @param event - The DOM Event
 * @param root - The aura:html component that is handling the event
 */
DomHandlersPlugin.prototype.dispatchActionHook = function (action, event, root) {
    if (!(event.type in DomHandlersPlugin.WHITELISTEVENTS)) {
        return;
    }
    
    var parent = $A.expressionService.getContainer(root).getConcreteComponent();

    // TODO: remove includeMetadata param before 206 release freeze: W-3378426
    var locator = parent.getLocator(root, true /*includeMetadata*/);

    // Only if we have a unique, identifier send the interaction
    if (locator) { 
        var target = root["getElement"]();
        var meta = target && target.getAttribute("data-refid"); // optional metadata

        var context = {
            "locator"     : locator,
            "eventType"   : DomHandlersPlugin.DEFAULT_INTERACTION_TYPE,
            "eventSource" : event.type // type of event (click, hover, scroll)
        };
        
        if (meta) {
            locator["context"] = locator["context"] || {};
            if (!locator["context"][meta]) {
                locator["context"][meta] = target.getAttribute("data-" + meta);
            }
        }

        $A.metricsService.transaction("aura", "interaction", { "context": context });
    } else if (event.type === "click") {
        this.logUnInstrumentedClick(parent, root);
    }
};

DomHandlersPlugin.prototype.logUnInstrumentedClick = function (parent, root) {
    var es = $A.expressionService;
    var grandparent = es.getContainer(parent).getConcreteComponent();
    var grandparentContainer = es.getContainer(grandparent).getConcreteComponent();
    // root will always be an aura:html component. It's the root of all our click handlers
    var hierarchy = {
            "rootHtmlTag": root.get("v.tag"),
            "rootId" : root.getLocalId(),
            "parent": parent.getDef().toString(),
            "parentId": parent.getLocalId(),
            "grandparent": grandparent.getDef().toString(),
            "grandparentId": grandparent.getLocalId(),
            "grandparentContainer": grandparentContainer.getDef().toString()
    };
    $A.metricsService.transaction("ltng", "performance:missingLocator", { "context": {
        "attributes": hierarchy
    }});
    $A.log("WARNING: **** Un-Instrumented click logged. Details: " + JSON.stringify(hierarchy));
};

DomHandlersPlugin.prototype.bindToHelper = function (descriptor, helperMethod) {
    var self = this;

    var defConfig  = $A.componentService.createDescriptorConfig(descriptor);
    var def        = $A.componentService.getComponentDef(defConfig);
    var defHelper  = def && def.getHelper();

    if (defHelper) {
        this.metricsService.instrument(
            defHelper, 
            helperMethod, 
            DomHandlersPlugin.NAME,
            false/*async*/,
            null, 
            null,
            function (original) {
                var xargs = Array.prototype.slice.call(arguments, 1);
                self.dispatchActionHook.apply(self, xargs);
                return original.apply(this, xargs);
            }
        );
    }    
};

DomHandlersPlugin.prototype.bind = function () {
    var self = this;
    $A.clientService.runAfterInitDefs(function () {
        self.bindToHelper("markup://aura:html", "dispatchAction");
        self.bindToHelper("markup://ui:virtualList", "_dispatchAction");
        self.bindToHelper("markup://ui:virtualDataGrid", "_dispatchAction");
        self.bindToHelper("markup://ui:virtualDataTable", "_dispatchAction");
        
        // This is for input* components
        var interactiveLib =    $A.componentService.hasLibrary("markup://ui:eventLib") &&
                                $A.componentService.getLibraryInclude("js://ui.eventLib.interactive");
        if (interactiveLib) {
            self.metricsService.instrument(
                    interactiveLib,
                    "_dispatchAction",
                    DomHandlersPlugin.NAME,
                    false/*async*/,
                    null, 
                    null,
                    function (original) {
                        var xargs = Array.prototype.slice.call(arguments, 1);
                        self.dispatchActionHook.apply(self, xargs);
                        return original.apply(this, xargs);
                    }
                );
        }
    });
};

//#if {"excludeModes" : ["PRODUCTION"]}
/** @export */
DomHandlersPlugin.prototype.postProcess = function (transportMarks) {
    return transportMarks;
};
//#end

DomHandlersPlugin.prototype.unbind = function (metricsService) {
        var defConfig  = $A.componentService.createDescriptorConfig("markup://aura:html");
        var htmlDef    = $A.componentService.getComponentDef(defConfig);
        var htmlHelper = htmlDef.getHelper();
    metricsService["unInstrument"](htmlHelper, "dispatchAction");
};

$A.metricsService.registerPlugin({
    "name"   : DomHandlersPlugin.NAME,
    "plugin" : DomHandlersPlugin
});
