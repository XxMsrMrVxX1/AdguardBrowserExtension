/**
 * This file is part of Adguard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * Adguard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Adguard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Adguard Browser Extension.  If not, see <http://www.gnu.org/licenses/>.
 */

(function (adguard) {

    'use strict';

    var CSP_HEADER_NAME = 'Content-Security-Policy';

    /**
     * Retrieve referrer url from request details.
     * Extract referrer by priority:
     * 1. referrerUrl in requestDetails
     * 2. url of frame where request was created
     * 3. url of main frame
     *
     * @param requestDetails
     * @returns {*|Frame}
     */
    function getReferrerUrl(requestDetails) {
        return requestDetails.referrerUrl ||
            adguard.frames.getFrameUrl(requestDetails.tab, requestDetails.requestFrameId) ||
            adguard.frames.getMainFrameUrl(requestDetails.tab);
    }

    /**
     * Process request
     *
     * @param requestDetails
     * @returns {boolean} False if request must be blocked
     */
    function onBeforeRequest(requestDetails) {
        var tab = requestDetails.tab;
        var requestId = requestDetails.requestId;
        var requestUrl = requestDetails.requestUrl;
        var requestType = requestDetails.requestType;

        if (requestType === adguard.RequestTypes.DOCUMENT || requestType === adguard.RequestTypes.SUBDOCUMENT) {
            adguard.frames.recordFrame(tab, requestDetails.frameId, requestUrl, requestType);
        }

        if (requestType === adguard.RequestTypes.DOCUMENT) {

            adguard.filteringLog.clearEventsByTabId(tab.tabId);

            // Reset tab button state
            adguard.listeners.notifyListeners(adguard.listeners.UPDATE_TAB_BUTTON_STATE, tab, true);

            /**
             * In the case of the "about:newtab" pages we don't receive onResponseReceived event for the main_frame, so we have to append log event here.
             * Also if chrome://newtab is overwritten, we won't receive any webRequest events for the main_frame
             * Unfortunately, we can't do anything in this case and just must remember about it
             */
            var tabRequestRule = adguard.frames.getFrameWhiteListRule(tab);
            adguard.filteringLog.addHttpRequestEvent(tab, requestUrl, requestUrl, requestType, tabRequestRule, requestId);

            return;
        }

        if (!adguard.utils.url.isHttpOrWsRequest(requestUrl)) {
            return;
        }

        var referrerUrl = getReferrerUrl(requestDetails);

        var requestRule = adguard.webRequestService.getRuleForRequest(tab, requestUrl, referrerUrl, requestType);

        adguard.webRequestService.postProcessRequest(tab, requestUrl, referrerUrl, requestType, requestRule, requestId);

        return adguard.webRequestService.getBlockedResponseByRule(requestRule, requestType);
    }

    /**
     * Called before request is sent to the remote endpoint.
     * This method is used to modify request in case of working in integration mode
     * and also to record referrer header in frame data.
     *
     * @param requestDetails Request details
     * @returns {*} headers to send
     */
    function onBeforeSendHeaders(requestDetails) {

        var tab = requestDetails.tab;
        var headers = requestDetails.requestHeaders;

        if (adguard.integration.shouldOverrideReferrer(tab)) {
            // Retrieve main frame url
            var mainFrameUrl = adguard.frames.getMainFrameUrl(tab);
            headers = adguard.utils.browser.setHeaderValue(headers, 'Referer', mainFrameUrl);
            return {
                requestHeaders: headers,
                modifiedHeaders: [{
                    name: 'Referer',
                    value: mainFrameUrl
                }]
            };
        }

        if (requestDetails.requestType === adguard.RequestTypes.DOCUMENT) {
            // Save ref header
            var refHeader = adguard.utils.browser.findHeaderByName(headers, 'Referer');
            if (refHeader) {
                adguard.frames.recordFrameReferrerHeader(tab, refHeader.value);
            }
        }

        return {};
    }

    /**
     * On headers received callback function.
     * We do check request for safebrowsing
     * and check if websocket connections should be blocked.
     *
     * @param requestDetails Request details
     * @returns {{responseHeaders: *}} Headers to send
     */
    function onHeadersReceived(requestDetails) {

        var tab = requestDetails.tab;
        var requestUrl = requestDetails.requestUrl;
        var responseHeaders = requestDetails.responseHeaders;
        var requestType = requestDetails.requestType;
        var referrerUrl = getReferrerUrl(requestDetails);
        var requestId = requestDetails.requestId;
        var statusCode = requestDetails.statusCode;
        var method = requestDetails.method;

        adguard.webRequestService.processRequestResponse(tab, requestUrl, referrerUrl, requestType, responseHeaders, requestId);

        // Safebrowsing check
        if (requestType === adguard.RequestTypes.DOCUMENT) {
            filterSafebrowsing(tab, requestUrl);
        }

        if (adguard.contentFiltering) {
            var contentType = adguard.utils.browser.getHeaderValueByName(responseHeaders, 'content-type');
            adguard.contentFiltering.apply(tab, requestUrl, referrerUrl, requestType, requestId, statusCode, method, contentType);
        }

        if (requestType === adguard.RequestTypes.DOCUMENT || requestType === adguard.RequestTypes.SUBDOCUMENT) {
            return modifyCSPHeader(requestDetails);
        }
    }

    /**
     * Before the introduction of $CSP rules, we used another approach for modifying Content-Security-Policy header.
     * We are looking for URL blocking rule that matches some request type and protocol (ws:, blob:, stun:)
     *
     * @param tab Tab
     * @param frameUrl Frame URL
     * @returns matching rule
     */
    function findLegacyCspRule(tab, frameUrl) {

        var rule = null;
        var applyCSP = false;

        /**
         * Websocket check.
         * If 'ws://' request is blocked for not existing domain - it's blocked for all domains.
         * More details in these issue:
         * https://github.com/AdguardTeam/AdguardBrowserExtension/issues/344
         * https://github.com/AdguardTeam/AdguardBrowserExtension/issues/440
         */

        // And we don't need this check on newer than 58 chromes anymore
        // https://github.com/AdguardTeam/AdguardBrowserExtension/issues/572
        if (!adguard.webRequest.webSocketSupported) {
            rule = adguard.webRequestService.getRuleForRequest(tab, 'ws://adguardwebsocket.check', frameUrl, adguard.RequestTypes.WEBSOCKET);
            applyCSP = adguard.webRequestService.isRequestBlockedByRule(rule);
        }
        if (!applyCSP) {
            rule = adguard.webRequestService.getRuleForRequest(tab, 'stun:adguardwebrtc.check', frameUrl, adguard.RequestTypes.WEBRTC);
        }

        return rule;
    }

    /**
     * Modify CSP header to block WebSocket, prohibit data: and blob: frames and WebWorkers
     * @param requestDetails
     * @returns {{responseHeaders: *}}
     */
    function modifyCSPHeader(requestDetails) {

        // Please note, that we do not modify response headers in Edge before Creators update:
        // https://github.com/AdguardTeam/AdguardBrowserExtension/issues/401
        // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/8796739/
        if (adguard.utils.browser.isEdgeBeforeCreatorsUpdate()) {
            return;
        }

        var tab = requestDetails.tab;
        var requestUrl = requestDetails.requestUrl;
        var responseHeaders = requestDetails.responseHeaders || [];
        var requestType = requestDetails.requestType;
        var frameUrl = adguard.frames.getFrameUrl(tab, requestDetails.frameId);

        var cspHeaders = [];

        var legacyCspRule = findLegacyCspRule(tab, frameUrl);
        if (adguard.webRequestService.isRequestBlockedByRule(legacyCspRule)) {
            cspHeaders.push({
                name: CSP_HEADER_NAME,
                value: adguard.rules.CspFilter.DEFAULT_DIRECTIVE
            });
        }
        if (legacyCspRule) {
            adguard.webRequestService.recordRuleHit(tab, legacyCspRule, frameUrl);
            adguard.filteringLog.addHttpRequestEvent(tab, 'content-security-policy-check', frameUrl, adguard.RequestTypes.CSP, legacyCspRule);
        }

        /**
         * Retrieve $CSP rules specific for the request
         * https://github.com/adguardteam/adguardbrowserextension/issues/685
         */
        var cspRules = adguard.webRequestService.getCspRules(tab, requestUrl, frameUrl, requestType);
        if (cspRules) {
            for (var i = 0; i < cspRules.length; i++) {
                var rule = cspRules[i];
                // Don't forget: getCspRules returns all $csp rules, we must directly check that the rule is blocking.
                if (adguard.webRequestService.isRequestBlockedByRule(rule)) {
                    cspHeaders.push({
                        name: CSP_HEADER_NAME,
                        value: rule.cspDirective
                    });
                }
                adguard.webRequestService.recordRuleHit(tab, rule, requestUrl);
                adguard.filteringLog.addHttpRequestEvent(tab, requestUrl, frameUrl, adguard.RequestTypes.CSP, rule);
            }
        }

        /**
         * Websocket connection is blocked by connect-src directive
         * https://www.w3.org/TR/CSP2/#directive-connect-src
         *
         * Web Workers is blocked by child-src directive
         * https://www.w3.org/TR/CSP2/#directive-child-src
         * https://www.w3.org/TR/CSP3/#directive-worker-src
         * We have to use child-src as fallback for worker-src, because it isn't supported
         * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/worker-src#Browser_compatibility
         *
         * We also need the frame-src restriction since CSPs are not inherited from the parent for documents with data: and blob: URLs
         * https://bugs.chromium.org/p/chromium/issues/detail?id=513860
         */
        if (cspHeaders.length > 0) {
            responseHeaders = responseHeaders.concat(cspHeaders);
            return {
                responseHeaders: responseHeaders,
                modifiedHeaders: cspHeaders
            };
        }
    }

    /**
     * Safebrowsing check
     *
     * @param tab
     * @param mainFrameUrl
     */
    function filterSafebrowsing(tab, mainFrameUrl) {

        if (adguard.frames.isTabAdguardDetected(tab) ||
            adguard.frames.isTabProtectionDisabled(tab) ||
            adguard.frames.isTabWhiteListedForSafebrowsing(tab)) {
            return;
        }

        var referrerUrl = adguard.utils.browser.getSafebrowsingBackUrl(tab);
        var incognitoTab = adguard.frames.isIncognitoTab(tab);

        adguard.safebrowsing.checkSafebrowsingFilter(mainFrameUrl, referrerUrl, function (safebrowsingUrl) {
            // Chrome doesn't allow open extension url in incognito mode
            // So close current tab and open new
            if (adguard.utils.browser.isChromium()) {
                adguard.ui.openTab(safebrowsingUrl, {}, function () {
                    adguard.tabs.remove(tab.tabId);
                });
            } else {
                adguard.tabs.reload(tab.tabId, safebrowsingUrl);
            }
        }, incognitoTab);
    }

    /**
     * Add listeners described above.
     */
    adguard.webRequest.onBeforeRequest.addListener(onBeforeRequest, ["<all_urls>"]);
    adguard.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, ["<all_urls>"]);
    adguard.webRequest.onHeadersReceived.addListener(onHeadersReceived, ["<all_urls>"]);

    // AG for Windows and Mac checks either request signature or request Referer to authorize request.
    // Referer cannot be forged by the website so it's ok for add-on authorization.
    if (adguard.integration.isSupported() && adguard.utils.browser.isChromium()) {

        /* global browser */
        browser.webRequest.onBeforeSendHeaders.addListener(function callback(details) {

            var authHeaders = adguard.integration.getAuthorizationHeaders();
            var headers = details.requestHeaders;
            for (var i = 0; i < authHeaders.length; i++) {
                headers = adguard.utils.browser.setHeaderValue(details.requestHeaders, authHeaders[i].headerName, authHeaders[i].headerValue);
            }

            return {requestHeaders: headers};

        }, {urls: [adguard.integration.getIntegrationBaseUrl() + "*"]}, ["requestHeaders", "blocking"]);
    }

    var handlerBehaviorTimeout = null;
    adguard.listeners.addListener(function (event) {
        switch (event) {
            case adguard.listeners.ADD_RULES:
            case adguard.listeners.REMOVE_RULE:
            case adguard.listeners.UPDATE_FILTER_RULES:
            case adguard.listeners.UPDATE_WHITELIST_FILTER_RULES:
            case adguard.listeners.FILTER_ENABLE_DISABLE:
                if (handlerBehaviorTimeout !== null) {
                    clearTimeout(handlerBehaviorTimeout);
                }
                handlerBehaviorTimeout = setTimeout(function () {
                    handlerBehaviorTimeout = null;
                    adguard.webRequest.handlerBehaviorChanged();
                }, 3000);
        }
    });

    var isEdgeBrowser = adguard.utils.browser.isEdgeBrowser();

    /**
     * Edge browser does not support `runAt` in options of tabs.executeScript
     */
    var shouldUseExecuteScript = !isEdgeBrowser;

    if (shouldUseExecuteScript) {
        /**
         * When frame is committed, we execute our JS rules in it.
         * We do this because we need to apply JS rules as soon as possible.
         * This listener should be added before tabs.insertCSS, in order to apply
         * without the overhead for looking up CSS rules.
         */
        (function fastScriptRulesLoader(adguard) {
            /**
             * Taken from
             * {@link https://github.com/seanl-adg/InlineResourceLiteral/blob/master/index.js#L136}
             * {@link https://github.com/joliss/js-string-escape/blob/master/index.js}
             */
            var reJsEscape = /["'\\\n\r\u2028\u2029]/g;
            function escapeJs(match) {
                switch (match) {
                    case '"':
                    case "'":
                    case '\\':
                        return '\\' + match
                    case '\n':
                        return '\\n\\\n' // Line continuation character for ease
                                        // of reading inlined resource.
                    case '\r':
                        return ''        // Carriage returns won't have
                                        // any semantic meaning in JS
                    case '\u2028':
                        return '\\u2028'
                    case '\u2029':
                        return '\\u2029'
                }
            }

            function tryInjectScripts(tabId, frameId, frame, result) {
                // Executes scripts in a scope of page.
                var injectedScript = '(function() {\
                    var script = document.createElement("script");\
                    script.setAttribute("type", "text/javascript");\
                    script.textContent = "' + result.scripts.replace(reJsEscape, escapeJs) + '";\
                    var parent = document.head || document.documentElement;\
                    try {\
                        parent.appendChild(script);\
                        parent.removeChild(script);\
                    } catch (e) {\
                    } finally {\
                        return true;\
                    }\
                })()';
                adguard.tabs.executeScript(tabId, {
                    code: injectedScript,
                    frameId: frameId,
                    runAt: 'document_start'
                }, function(response) {
                    adguard.runtime.lastError;
                    // This can happen with Chrome preloaded tabs
                    // See https://stackoverflow.com/questions/43665470/cannot-call-chrome-tabs-executescript-into-preloaded-tab-is-this-a-bug-in-chr
                });

                // Update frames metadata
                frame.executedJS = true;
            }

            adguard.webNavigation.onCommitted.addListener(function (details) {
                var tabId = details.tabId;
                var frameId = details.frameId;
                var url = details.url;

                var frame = adguard.tabs.getTabFrame(tabId, frameId);
                if (!frame || frame.executedJS) {
                    return;
                }

                var bits = adguard.webRequestService.GetSelectorAndScriptsEnum;
                var getScripts = bits.RETRIEVE_SCRIPTS;
                var result = adguard.webRequestService.processGetSelectorsAndScripts({tabId: tabId}, url, getScripts);

                if (!result.scripts || result.scripts.length === 0) {
                    return;
                }
                tryInjectScripts(tabId, frameId, frame, result);
            });
        })(adguard);
    }

    /**
     * Edge browser does not support `runAt` in options of tabs.insertCSS
     */
    var shouldUseInsertCSS = !isEdgeBrowser;

    /**
     * Whether it implements cssOrigin: 'user' option.
     * Style declarations in user origin stylesheets that have `!important` priority
     * takes precedence over page styles
     * {@link https://developer.mozilla.org/en-US/docs/Web/CSS/Cascade#Cascading_order}
     */
    var userCSSSupport =
        typeof adguard.extensionTypes === 'object' &&
        typeof adguard.extensionTypes.CSSOrigin !== 'undefined';

    if (shouldUseInsertCSS) {
        (function insertCSS(adguard){
            function tryInsertCss(tabId, frameId, frame, css) {
                var cssStringified = css.join(' ');

                var details = {
                    code: cssStringified,
                    runAt: 'document_start'
                    //, matchAboutBlank: true
                };

                if (userCSSSupport) {
                    // If this is set for not supporting browser, it will throw an error.
                    details.cssOrigin = 'user';
                }

                adguard.tabs.insertCSS(tabId, details, function () {
                    adguard.runtime.lastError;
                    // This can happen with Chrome preloaded tabs.
                });
                // Update frame data, so that we do not needlessly request
                // stylesheets on message from content script.
                frame.insertedCSS = true;
            }

            adguard.webNavigation.onCommitted.addListener(function (details) {
                var tabId = details.tabId;
                var frameId = details.frameId;
                var url = details.url;

                /**
                 * We should use tabs.insertCSS only on top frames.
                 */
                if (frameId !== 0) {
                    return;
                }

                var frame = adguard.tabs.getTabFrame(tabId, frameId);
                if (!frame || frame.insertedCSS) {
                    return;
                }

                var bits = adguard.webRequestService.GetSelectorAndScriptsEnum;
                var shouldGetTraditionalCssOnly = bits.RETRIEVE_TRADITIONAL_CSS;

                var result = adguard.webRequestService.processGetSelectorsAndScripts({tabId: tabId}, url, shouldGetTraditionalCssOnly);

                if (!result.selectors || !result.selectors.css) {
                    return;
                }
                tryInsertCss(tabId, frameId, frame, result.selectors.css);
            });
        })(adguard);
    }


})(adguard);
