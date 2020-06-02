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

(function (adguard, api) {
    /**
     * Simple MultiMap implementation
     * @constructor
     */
    const MultiMap = function () {
        this.map = Object.create(null);
        this.size = 0;

        this.put = function (key, value) {
            let values = this.map[key];
            if (!values) {
                this.map[key] = values = [];
                this.size += 1;
            }
            values.push(value);
        };

        this.remove = function (key, value) {
            const values = this.map[key];
            if (!values) {
                return;
            }
            adguard.utils.collections.removeRule(values, value);
            if (values.length === 0) {
                delete this.map[key];
                this.size -= 1;
            }
        };

        this.get = function (key) {
            return this.map[key];
        };

        this.clear = function () {
            this.map = Object.create(null);
        };

        this.isEmpty = function () {
            return this.size === 0;
        };
    };

    /**
     * Filter that applies content rules
     */
    const ContentFilter = function (rules) {
        this.contentRules = [];
        this.exceptionRulesMap = new MultiMap();
        this.dirty = false;

        if (rules) {
            for (let i = 0; i < rules.length; i += 1) {
                this.addRule(rules[i]);
            }
        }
    };

    ContentFilter.prototype = {

        /**
         * Adds new rule to ContentFilter
         *
         * @param rule Rule to add
         */
        addRule(rule) {
            if (!rule.tagName) {
                // Ignore invalid rules
                return;
            }

            if (rule.whiteListRule) {
                this.exceptionRulesMap.put(rule.elementsFilter, rule);
            } else {
                this.contentRules.push(rule);
            }

            this.dirty = true;
        },

        /**
         * Removes rule from the ContentFilter
         *
         * @param rule Rule to remove
         */
        removeRule(rule) {
            adguard.utils.collections.removeRule(this.contentRules, rule);
            this.exceptionRulesMap.remove(rule.elementsFilter, rule);
            this.rollbackExceptionRule(rule);
            this.dirty = true;
        },

        /**
         * Searches for the content rules
         *
         * @param domainName Domain
         * @returns Collection of the content rules or null
         */
        getRulesForDomain(domainName) {
            if (this.dirty) {
                this.rebuild();
            }

            let result = null;

            for (let i = 0; i < this.contentRules.length; i += 1) {
                const rule = this.contentRules[i];
                if (rule.isPermitted(domainName)) {
                    if (result === null) {
                        result = [];
                    }
                    result.push(rule);
                }
            }

            return result;
        },

        /**
         * Searches for elements in document that matches given content rules
         * @param doc Document
         * @param rules Content rules
         * @returns Matched elements
         */
        getMatchedElementsForRules(doc, rules) {
            if (!rules || rules.length === 0) {
                return null;
            }

            let result = null;

            for (let i = 0; i < rules.length; i += 1) {
                const rule = rules[i];
                const elements = rule.getMatchedElements(doc);
                if (elements && elements.length > 0) {
                    if (result === null) {
                        result = [];
                    }
                    result = result.concat(elements);
                }
            }

            return result;
        },

        /**
         * Searches for elements in document that matches content rules for the specified domain
         * @param doc Document
         * @param domainName Domain
         * @returns Matched elements
         */
        getMatchedElements(doc, domainName) {
            if (this.dirty) {
                this.rebuild();
            }

            const rules = this.getRulesForDomain(domainName);
            if (rules) {
                return this.getMatchedElementsForRules(doc, rules);
            }
            return null;
        },

        /**
         * Rebuilds content filter and re-applies exceptions rules
         */
        rebuild() {
            if (!this.dirty) {
                return;
            }

            if (!this.exceptionRulesMap.isEmpty()) {
                for (let i = 0; i < this.contentRules.length; i += 1) {
                    this.applyExceptionRules(this.contentRules[i]);
                }
            }
            this.dirty = false;
        },

        /**
         * Finds exception rules corresponding to this rule and applies them.
         *
         * @param rule Regular script rule
         */
        applyExceptionRules(rule) {
            const exceptionRules = this.exceptionRulesMap.get(rule.elementsFilter);

            if (exceptionRules) {
                for (let i = 0; i < exceptionRules.length; i += 1) {
                    const exceptionRule = exceptionRules[i];
                    this.applyExceptionRule(rule, exceptionRule);
                }
            }
        },

        /**
         * Tries to apply specified exception rule to a regular rule.
         *
         * @param rule          Regular rule
         * @param exceptionRule Exception rule
         */
        applyExceptionRule(rule, exceptionRule) {
            // If cannot be applied - exiting
            if (rule.elementsFilter !== exceptionRule.elementsFilter) {
                return;
            }

            // Permitted domains from exception rule --> restricted domains in common rule
            rule.addRestrictedDomains(exceptionRule.getPermittedDomains());
        },

        /**
         * Rolls back specified exception rule
         *
         * @param exceptionRule Exception rule to rollback
         */
        rollbackExceptionRule(exceptionRule) {
            if (!exceptionRule.whiteListRule) {
                return;
            }

            for (let i = 0; i < this.contentRules.length; i += 1) {
                const rule = this.contentRules[i];
                if (rule.elementsFilter === exceptionRule.elementsFilter) {
                    rule.removeRestrictedDomains(exceptionRule.getPermittedDomains());
                }
            }
        },
    };

    api.ContentFilter = ContentFilter;
})(adguard, adguard.rules);
