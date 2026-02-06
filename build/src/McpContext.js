/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractUrlLikeFromDevToolsTitle, UniverseManager, urlsEqual, } from './DevtoolsUtils.js';
import { NetworkCollector, ConsoleCollector } from './PageCollector.js';
import { Locator } from './third_party/index.js';
import { listPages } from './tools/pages.js';
import { takeSnapshot } from './tools/snapshot.js';
import { CLOSE_PAGE_ERROR } from './tools/ToolDefinition.js';
import { ExtensionRegistry, } from './utils/ExtensionRegistry.js';
import { WaitForHelper } from './WaitForHelper.js';
const DEFAULT_TIMEOUT = 5_000;
const NAVIGATION_TIMEOUT = 10_000;
function getNetworkMultiplierFromString(condition) {
    const puppeteerCondition = condition;
    switch (puppeteerCondition) {
        case 'Fast 4G':
            return 1;
        case 'Slow 4G':
            return 2.5;
        case 'Fast 3G':
            return 5;
        case 'Slow 3G':
            return 10;
    }
    return 1;
}
function getExtensionFromMimeType(mimeType) {
    switch (mimeType) {
        case 'image/png':
            return 'png';
        case 'image/jpeg':
            return 'jpeg';
        case 'image/webp':
            return 'webp';
    }
    throw new Error(`No mapping for Mime type ${mimeType}.`);
}
export class McpContext {
    browser;
    logger;
    // The most recent page state.
    #pages = [];
    #pageToDevToolsPage = new Map();
    #selectedPage;
    // The most recent snapshot.
    #textSnapshot = null;
    #networkCollector;
    #consoleCollector;
    #devtoolsUniverseManager;
    #extensionRegistry = new ExtensionRegistry();
    #isRunningTrace = false;
    #networkConditionsMap = new WeakMap();
    #cpuThrottlingRateMap = new WeakMap();
    #geolocationMap = new WeakMap();
    #viewportMap = new WeakMap();
    #userAgentMap = new WeakMap();
    #colorSchemeMap = new WeakMap();
    #dialog;
    #pageIdMap = new WeakMap();
    #nextPageId = 1;
    #nextSnapshotId = 1;
    #traceResults = [];
    #locatorClass;
    #options;
    #uniqueBackendNodeIdToMcpId = new Map();
    constructor(browser, logger, options, locatorClass) {
        this.browser = browser;
        this.logger = logger;
        this.#locatorClass = locatorClass;
        this.#options = options;
        this.#networkCollector = new NetworkCollector(this.browser);
        this.#consoleCollector = new ConsoleCollector(this.browser, collect => {
            return {
                console: event => {
                    collect(event);
                },
                uncaughtError: event => {
                    collect(event);
                },
                issue: event => {
                    collect(event);
                },
            };
        });
        this.#devtoolsUniverseManager = new UniverseManager(this.browser);
    }
    async #init() {
        const pages = await this.createPagesSnapshot();
        await this.#networkCollector.init(pages);
        await this.#consoleCollector.init(pages);
        await this.#devtoolsUniverseManager.init(pages);
    }
    dispose() {
        this.#networkCollector.dispose();
        this.#consoleCollector.dispose();
        this.#devtoolsUniverseManager.dispose();
    }
    static async from(browser, logger, opts, 
    /* Let tests use unbundled Locator class to avoid overly strict checks within puppeteer that fail when mixing bundled and unbundled class instances */
    locatorClass = Locator) {
        const context = new McpContext(browser, logger, opts, locatorClass);
        await context.#init();
        return context;
    }
    resolveCdpRequestId(cdpRequestId) {
        const selectedPage = this.getSelectedPage();
        if (!cdpRequestId) {
            this.logger('no network request');
            return;
        }
        const request = this.#networkCollector.find(selectedPage, request => {
            // @ts-expect-error id is internal.
            return request.id === cdpRequestId;
        });
        if (!request) {
            this.logger('no network request for ' + cdpRequestId);
            return;
        }
        return this.#networkCollector.getIdForResource(request);
    }
    resolveCdpElementId(cdpBackendNodeId) {
        if (!cdpBackendNodeId) {
            this.logger('no cdpBackendNodeId');
            return;
        }
        if (this.#textSnapshot === null) {
            this.logger('no text snapshot');
            return;
        }
        // TODO: index by backendNodeId instead.
        const queue = [this.#textSnapshot.root];
        while (queue.length) {
            const current = queue.pop();
            if (current.backendNodeId === cdpBackendNodeId) {
                return current.id;
            }
            for (const child of current.children) {
                queue.push(child);
            }
        }
        return;
    }
    getNetworkRequests(includePreservedRequests) {
        const page = this.getSelectedPage();
        return this.#networkCollector.getData(page, includePreservedRequests);
    }
    getConsoleData(includePreservedMessages) {
        const page = this.getSelectedPage();
        return this.#consoleCollector.getData(page, includePreservedMessages);
    }
    getDevToolsUniverse() {
        return this.#devtoolsUniverseManager.get(this.getSelectedPage());
    }
    getConsoleMessageStableId(message) {
        return this.#consoleCollector.getIdForResource(message);
    }
    getConsoleMessageById(id) {
        return this.#consoleCollector.getById(this.getSelectedPage(), id);
    }
    async newPage(background) {
        const page = await this.browser.newPage({ background });
        await this.createPagesSnapshot();
        this.selectPage(page);
        this.#networkCollector.addPage(page);
        this.#consoleCollector.addPage(page);
        return page;
    }
    async closePage(pageId) {
        if (this.#pages.length === 1) {
            throw new Error(CLOSE_PAGE_ERROR);
        }
        const page = this.getPageById(pageId);
        await page.close({ runBeforeUnload: false });
    }
    getNetworkRequestById(reqid) {
        return this.#networkCollector.getById(this.getSelectedPage(), reqid);
    }
    setNetworkConditions(conditions) {
        const page = this.getSelectedPage();
        if (conditions === null) {
            this.#networkConditionsMap.delete(page);
        }
        else {
            this.#networkConditionsMap.set(page, conditions);
        }
        this.#updateSelectedPageTimeouts();
    }
    getNetworkConditions() {
        const page = this.getSelectedPage();
        return this.#networkConditionsMap.get(page) ?? null;
    }
    setCpuThrottlingRate(rate) {
        const page = this.getSelectedPage();
        this.#cpuThrottlingRateMap.set(page, rate);
        this.#updateSelectedPageTimeouts();
    }
    getCpuThrottlingRate() {
        const page = this.getSelectedPage();
        return this.#cpuThrottlingRateMap.get(page) ?? 1;
    }
    setGeolocation(geolocation) {
        const page = this.getSelectedPage();
        if (geolocation === null) {
            this.#geolocationMap.delete(page);
        }
        else {
            this.#geolocationMap.set(page, geolocation);
        }
    }
    getGeolocation() {
        const page = this.getSelectedPage();
        return this.#geolocationMap.get(page) ?? null;
    }
    setViewport(viewport) {
        const page = this.getSelectedPage();
        if (viewport === null) {
            this.#viewportMap.delete(page);
        }
        else {
            this.#viewportMap.set(page, viewport);
        }
    }
    getViewport() {
        const page = this.getSelectedPage();
        return this.#viewportMap.get(page) ?? null;
    }
    setUserAgent(userAgent) {
        const page = this.getSelectedPage();
        if (userAgent === null) {
            this.#userAgentMap.delete(page);
        }
        else {
            this.#userAgentMap.set(page, userAgent);
        }
    }
    getUserAgent() {
        const page = this.getSelectedPage();
        return this.#userAgentMap.get(page) ?? null;
    }
    setColorScheme(scheme) {
        const page = this.getSelectedPage();
        if (scheme === null) {
            this.#colorSchemeMap.delete(page);
        }
        else {
            this.#colorSchemeMap.set(page, scheme);
        }
    }
    getColorScheme() {
        const page = this.getSelectedPage();
        return this.#colorSchemeMap.get(page) ?? null;
    }
    setIsRunningPerformanceTrace(x) {
        this.#isRunningTrace = x;
    }
    isRunningPerformanceTrace() {
        return this.#isRunningTrace;
    }
    isCruxEnabled() {
        return this.#options.performanceCrux;
    }
    getDialog() {
        return this.#dialog;
    }
    clearDialog() {
        this.#dialog = undefined;
    }
    getSelectedPage() {
        const page = this.#selectedPage;
        if (!page) {
            throw new Error('No page selected');
        }
        if (page.isClosed()) {
            throw new Error(`The selected page has been closed. Call ${listPages.name} to see open pages.`);
        }
        return page;
    }
    getPageById(pageId) {
        const page = this.#pages.find(p => this.#pageIdMap.get(p) === pageId);
        if (!page) {
            throw new Error('No page found');
        }
        return page;
    }
    getPageId(page) {
        return this.#pageIdMap.get(page);
    }
    #dialogHandler = (dialog) => {
        this.#dialog = dialog;
    };
    isPageSelected(page) {
        return this.#selectedPage === page;
    }
    selectPage(newPage) {
        const oldPage = this.#selectedPage;
        if (oldPage) {
            oldPage.off('dialog', this.#dialogHandler);
            void oldPage.emulateFocusedPage(false).catch(error => {
                this.logger('Error turning off focused page emulation', error);
            });
        }
        this.#selectedPage = newPage;
        newPage.on('dialog', this.#dialogHandler);
        this.#updateSelectedPageTimeouts();
        void newPage.emulateFocusedPage(true).catch(error => {
            this.logger('Error turning on focused page emulation', error);
        });
    }
    #updateSelectedPageTimeouts() {
        const page = this.getSelectedPage();
        // For waiters 5sec timeout should be sufficient.
        // Increased in case we throttle the CPU
        const cpuMultiplier = this.getCpuThrottlingRate();
        page.setDefaultTimeout(DEFAULT_TIMEOUT * cpuMultiplier);
        // 10sec should be enough for the load event to be emitted during
        // navigations.
        // Increased in case we throttle the network requests
        const networkMultiplier = getNetworkMultiplierFromString(this.getNetworkConditions());
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT * networkMultiplier);
    }
    getNavigationTimeout() {
        const page = this.getSelectedPage();
        return page.getDefaultNavigationTimeout();
    }
    getAXNodeByUid(uid) {
        return this.#textSnapshot?.idToNode.get(uid);
    }
    async getElementByUid(uid) {
        if (!this.#textSnapshot?.idToNode.size) {
            throw new Error(`No snapshot found. Use ${takeSnapshot.name} to capture one.`);
        }
        const node = this.#textSnapshot?.idToNode.get(uid);
        if (!node) {
            throw new Error('No such element found in the snapshot.');
        }
        const message = `Element with uid ${uid} no longer exists on the page.`;
        try {
            const handle = await node.elementHandle();
            if (!handle) {
                throw new Error(message);
            }
            return handle;
        }
        catch (error) {
            throw new Error(message, {
                cause: error,
            });
        }
    }
    /**
     * Creates a snapshot of the pages.
     */
    async createPagesSnapshot() {
        const allPages = await this.browser.pages(this.#options.experimentalIncludeAllPages);
        for (const page of allPages) {
            if (!this.#pageIdMap.has(page)) {
                this.#pageIdMap.set(page, this.#nextPageId++);
            }
        }
        this.#pages = allPages.filter(page => {
            // If we allow debugging DevTools windows, return all pages.
            // If we are in regular mode, the user should only see non-DevTools page.
            return (this.#options.experimentalDevToolsDebugging ||
                !page.url().startsWith('devtools://'));
        });
        if ((!this.#selectedPage || this.#pages.indexOf(this.#selectedPage) === -1) &&
            this.#pages[0]) {
            this.selectPage(this.#pages[0]);
        }
        await this.detectOpenDevToolsWindows();
        return this.#pages;
    }
    async detectOpenDevToolsWindows() {
        this.logger('Detecting open DevTools windows');
        const pages = await this.browser.pages(this.#options.experimentalIncludeAllPages);
        this.#pageToDevToolsPage = new Map();
        for (const devToolsPage of pages) {
            if (devToolsPage.url().startsWith('devtools://')) {
                try {
                    this.logger('Calling getTargetInfo for ' + devToolsPage.url());
                    const data = await devToolsPage
                        // @ts-expect-error no types for _client().
                        ._client()
                        .send('Target.getTargetInfo');
                    const devtoolsPageTitle = data.targetInfo.title;
                    const urlLike = extractUrlLikeFromDevToolsTitle(devtoolsPageTitle);
                    if (!urlLike) {
                        continue;
                    }
                    // TODO: lookup without a loop.
                    for (const page of this.#pages) {
                        if (urlsEqual(page.url(), urlLike)) {
                            this.#pageToDevToolsPage.set(page, devToolsPage);
                        }
                    }
                }
                catch (error) {
                    this.logger('Issue occurred while trying to find DevTools', error);
                }
            }
        }
    }
    getPages() {
        return this.#pages;
    }
    async getForegroundPage() {
        const pages = this.getPages();
        if (pages.length === 0) {
            return null;
        }
        const selectedPage = this.#selectedPage;
        let foregroundPage = null;
        // Read selected text from all pages BEFORE toggling emulation.
        // Disabling focus emulation fires visibilitychange which can clear
        // selections, so we capture them while the state is undisturbed.
        const selectionByPage = new Map();
        for (const page of pages) {
            if (page.isClosed()) {
                continue;
            }
            try {
                const text = await page.evaluate(() => window.getSelection()?.toString() ?? '');
                if (text) {
                    selectionByPage.set(page, text);
                }
            }
            catch (error) {
                this.logger('Error reading selection', page.url(), error);
            }
        }
        try {
            // Disable focus emulation on ALL pages to read real visibilityState.
            await Promise.all(pages.map(page => page.emulateFocusedPage(false).catch(error => {
                this.logger('Error disabling focus emulation', error);
            })));
            // Find the page with real visibilityState === "visible".
            for (const page of pages) {
                if (page.isClosed()) {
                    continue;
                }
                try {
                    const state = await page.evaluate(() => document.visibilityState);
                    if (state === 'visible') {
                        foregroundPage = page;
                        break;
                    }
                }
                catch (error) {
                    this.logger('Error checking visibility', page.url(), error);
                }
            }
        }
        finally {
            // Restore focus emulation on the selected page.
            if (selectedPage && !selectedPage.isClosed()) {
                void selectedPage.emulateFocusedPage(true).catch(error => {
                    this.logger('Error re-enabling focus emulation', error);
                });
            }
        }
        if (!foregroundPage) {
            return null;
        }
        return {
            page: foregroundPage,
            pageId: this.getPageId(foregroundPage),
            selectedText: selectionByPage.get(foregroundPage) ?? '',
        };
    }
    getDevToolsPage(page) {
        return this.#pageToDevToolsPage.get(page);
    }
    async getDevToolsData() {
        try {
            this.logger('Getting DevTools UI data');
            const selectedPage = this.getSelectedPage();
            const devtoolsPage = this.getDevToolsPage(selectedPage);
            if (!devtoolsPage) {
                this.logger('No DevTools page detected');
                return {};
            }
            const { cdpRequestId, cdpBackendNodeId } = await devtoolsPage.evaluate(async () => {
                // @ts-expect-error no types
                const UI = await import('/bundled/ui/legacy/legacy.js');
                // @ts-expect-error no types
                const SDK = await import('/bundled/core/sdk/sdk.js');
                const request = UI.Context.Context.instance().flavor(SDK.NetworkRequest.NetworkRequest);
                const node = UI.Context.Context.instance().flavor(SDK.DOMModel.DOMNode);
                return {
                    cdpRequestId: request?.requestId(),
                    cdpBackendNodeId: node?.backendNodeId(),
                };
            });
            return { cdpBackendNodeId, cdpRequestId };
        }
        catch (err) {
            this.logger('error getting devtools data', err);
        }
        return {};
    }
    /**
     * Creates a text snapshot of a page.
     */
    async createTextSnapshot(verbose = false, devtoolsData = undefined) {
        const page = this.getSelectedPage();
        const rootNode = await page.accessibility.snapshot({
            includeIframes: true,
            interestingOnly: !verbose,
        });
        if (!rootNode) {
            return;
        }
        const snapshotId = this.#nextSnapshotId++;
        // Iterate through the whole accessibility node tree and assign node ids that
        // will be used for the tree serialization and mapping ids back to nodes.
        let idCounter = 0;
        const idToNode = new Map();
        const seenUniqueIds = new Set();
        const assignIds = (node) => {
            let id = '';
            // @ts-expect-error untyped loaderId & backendNodeId.
            const uniqueBackendId = `${node.loaderId}_${node.backendNodeId}`;
            if (this.#uniqueBackendNodeIdToMcpId.has(uniqueBackendId)) {
                // Re-use MCP exposed ID if the uniqueId is the same.
                id = this.#uniqueBackendNodeIdToMcpId.get(uniqueBackendId);
            }
            else {
                // Only generate a new ID if we have not seen the node before.
                id = `${snapshotId}_${idCounter++}`;
                this.#uniqueBackendNodeIdToMcpId.set(uniqueBackendId, id);
            }
            seenUniqueIds.add(uniqueBackendId);
            const nodeWithId = {
                ...node,
                id,
                children: node.children
                    ? node.children.map(child => assignIds(child))
                    : [],
            };
            // The AXNode for an option doesn't contain its `value`.
            // Therefore, set text content of the option as value.
            if (node.role === 'option') {
                const optionText = node.name;
                if (optionText) {
                    nodeWithId.value = optionText.toString();
                }
            }
            idToNode.set(nodeWithId.id, nodeWithId);
            return nodeWithId;
        };
        const rootNodeWithId = assignIds(rootNode);
        this.#textSnapshot = {
            root: rootNodeWithId,
            snapshotId: String(snapshotId),
            idToNode,
            hasSelectedElement: false,
            verbose,
        };
        const data = devtoolsData ?? (await this.getDevToolsData());
        if (data?.cdpBackendNodeId) {
            this.#textSnapshot.hasSelectedElement = true;
            this.#textSnapshot.selectedElementUid = this.resolveCdpElementId(data?.cdpBackendNodeId);
        }
        // Clean up unique IDs that we did not see anymore.
        for (const key of this.#uniqueBackendNodeIdToMcpId.keys()) {
            if (!seenUniqueIds.has(key)) {
                this.#uniqueBackendNodeIdToMcpId.delete(key);
            }
        }
    }
    getTextSnapshot() {
        return this.#textSnapshot;
    }
    async saveTemporaryFile(data, mimeType) {
        try {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-devtools-mcp-'));
            const filename = path.join(dir, `screenshot.${getExtensionFromMimeType(mimeType)}`);
            await fs.writeFile(filename, data);
            return { filename };
        }
        catch (err) {
            this.logger(err);
            throw new Error('Could not save a screenshot to a file', { cause: err });
        }
    }
    async saveFile(data, filename) {
        try {
            const filePath = path.resolve(filename);
            await fs.writeFile(filePath, data);
            return { filename };
        }
        catch (err) {
            this.logger(err);
            throw new Error('Could not save a screenshot to a file', { cause: err });
        }
    }
    storeTraceRecording(result) {
        // Clear the trace results because we only consume the latest trace currently.
        this.#traceResults = [];
        this.#traceResults.push(result);
    }
    recordedTraces() {
        return this.#traceResults;
    }
    getWaitForHelper(page, cpuMultiplier, networkMultiplier) {
        return new WaitForHelper(page, cpuMultiplier, networkMultiplier);
    }
    waitForEventsAfterAction(action, options) {
        const page = this.getSelectedPage();
        const cpuMultiplier = this.getCpuThrottlingRate();
        const networkMultiplier = getNetworkMultiplierFromString(this.getNetworkConditions());
        const waitForHelper = this.getWaitForHelper(page, cpuMultiplier, networkMultiplier);
        return waitForHelper.waitForEventsAfterAction(action, options);
    }
    getNetworkRequestStableId(request) {
        return this.#networkCollector.getIdForResource(request);
    }
    waitForTextOnPage(text, timeout) {
        const page = this.getSelectedPage();
        const frames = page.frames();
        let locator = this.#locatorClass.race(frames.flatMap(frame => [
            frame.locator(`aria/${text}`),
            frame.locator(`text/${text}`),
        ]));
        if (timeout) {
            locator = locator.setTimeout(timeout);
        }
        return locator.wait();
    }
    /**
     * We need to ignore favicon request as they make our test flaky
     */
    async setUpNetworkCollectorForTesting() {
        this.#networkCollector = new NetworkCollector(this.browser, collect => {
            return {
                request: req => {
                    if (req.url().includes('favicon.ico')) {
                        return;
                    }
                    collect(req);
                },
            };
        });
        await this.#networkCollector.init(await this.browser.pages());
    }
    async installExtension(extensionPath) {
        const id = await this.browser.installExtension(extensionPath);
        await this.#extensionRegistry.registerExtension(id, extensionPath);
        return id;
    }
    async uninstallExtension(id) {
        await this.browser.uninstallExtension(id);
        this.#extensionRegistry.remove(id);
    }
    listExtensions() {
        return this.#extensionRegistry.list();
    }
    getExtension(id) {
        return this.#extensionRegistry.getById(id);
    }
}
