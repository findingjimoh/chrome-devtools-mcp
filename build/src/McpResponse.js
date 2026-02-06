/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { ConsoleFormatter } from './formatters/ConsoleFormatter.js';
import { IssueFormatter } from './formatters/IssueFormatter.js';
import { NetworkFormatter } from './formatters/NetworkFormatter.js';
import { SnapshotFormatter } from './formatters/SnapshotFormatter.js';
import { UncaughtError } from './PageCollector.js';
import { DevTools } from './third_party/index.js';
import { handleDialog } from './tools/pages.js';
import { getInsightOutput, getTraceSummary } from './trace-processing/parse.js';
import { paginate } from './utils/pagination.js';
export class McpResponse {
    #includePages = false;
    #snapshotParams;
    #attachedNetworkRequestId;
    #attachedNetworkRequestOptions;
    #attachedConsoleMessageId;
    #attachedTraceSummary;
    #attachedTraceInsight;
    #textResponseLines = [];
    #images = [];
    #networkRequestsOptions;
    #consoleDataOptions;
    #listExtensions;
    #devToolsData;
    #tabId;
    attachDevToolsData(data) {
        this.#devToolsData = data;
    }
    setTabId(tabId) {
        this.#tabId = tabId;
    }
    setIncludePages(value) {
        this.#includePages = value;
    }
    includeSnapshot(params) {
        this.#snapshotParams = params ?? {
            verbose: false,
        };
    }
    setListExtensions() {
        this.#listExtensions = true;
    }
    setIncludeNetworkRequests(value, options) {
        if (!value) {
            this.#networkRequestsOptions = undefined;
            return;
        }
        this.#networkRequestsOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            resourceTypes: options?.resourceTypes,
            includePreservedRequests: options?.includePreservedRequests,
            networkRequestIdInDevToolsUI: options?.networkRequestIdInDevToolsUI,
        };
    }
    setIncludeConsoleData(value, options) {
        if (!value) {
            this.#consoleDataOptions = undefined;
            return;
        }
        this.#consoleDataOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            types: options?.types,
            includePreservedMessages: options?.includePreservedMessages,
        };
    }
    attachNetworkRequest(reqid, options) {
        this.#attachedNetworkRequestId = reqid;
        this.#attachedNetworkRequestOptions = options;
    }
    attachConsoleMessage(msgid) {
        this.#attachedConsoleMessageId = msgid;
    }
    attachTraceSummary(result) {
        this.#attachedTraceSummary = result;
    }
    attachTraceInsight(trace, insightSetId, insightName) {
        this.#attachedTraceInsight = {
            trace,
            insightSetId,
            insightName,
        };
    }
    get includePages() {
        return this.#includePages;
    }
    get attachedTraceSummary() {
        return this.#attachedTraceSummary;
    }
    get attachedTracedInsight() {
        return this.#attachedTraceInsight;
    }
    get includeNetworkRequests() {
        return this.#networkRequestsOptions?.include ?? false;
    }
    get includeConsoleData() {
        return this.#consoleDataOptions?.include ?? false;
    }
    get attachedNetworkRequestId() {
        return this.#attachedNetworkRequestId;
    }
    get networkRequestsPageIdx() {
        return this.#networkRequestsOptions?.pagination?.pageIdx;
    }
    get consoleMessagesPageIdx() {
        return this.#consoleDataOptions?.pagination?.pageIdx;
    }
    get consoleMessagesTypes() {
        return this.#consoleDataOptions?.types;
    }
    appendResponseLine(value) {
        this.#textResponseLines.push(value);
    }
    attachImage(value) {
        this.#images.push(value);
    }
    get responseLines() {
        return this.#textResponseLines;
    }
    get images() {
        return this.#images;
    }
    get snapshotParams() {
        return this.#snapshotParams;
    }
    async handle(toolName, context) {
        if (this.#includePages) {
            await context.createPagesSnapshot();
        }
        let snapshot;
        if (this.#snapshotParams) {
            await context.createTextSnapshot(this.#snapshotParams.verbose, this.#devToolsData);
            const textSnapshot = context.getTextSnapshot();
            if (textSnapshot) {
                const formatter = new SnapshotFormatter(textSnapshot);
                if (this.#snapshotParams.filePath) {
                    await context.saveFile(new TextEncoder().encode(formatter.toString()), this.#snapshotParams.filePath);
                    snapshot = this.#snapshotParams.filePath;
                }
                else {
                    snapshot = formatter;
                }
            }
        }
        let detailedNetworkRequest;
        if (this.#attachedNetworkRequestId) {
            const request = context.getNetworkRequestById(this.#attachedNetworkRequestId);
            const formatter = await NetworkFormatter.from(request, {
                requestId: this.#attachedNetworkRequestId,
                requestIdResolver: req => context.getNetworkRequestStableId(req),
                fetchData: true,
                requestFilePath: this.#attachedNetworkRequestOptions?.requestFilePath,
                responseFilePath: this.#attachedNetworkRequestOptions?.responseFilePath,
                saveFile: (data, filename) => context.saveFile(data, filename),
            });
            detailedNetworkRequest = formatter;
        }
        let detailedConsoleMessage;
        if (this.#attachedConsoleMessageId) {
            const message = context.getConsoleMessageById(this.#attachedConsoleMessageId);
            const consoleMessageStableId = this.#attachedConsoleMessageId;
            if ('args' in message || message instanceof UncaughtError) {
                const consoleMessage = message;
                const devTools = context.getDevToolsUniverse();
                detailedConsoleMessage = await ConsoleFormatter.from(consoleMessage, {
                    id: consoleMessageStableId,
                    fetchDetailedData: true,
                    devTools: devTools ?? undefined,
                });
            }
            else if (message instanceof DevTools.AggregatedIssue) {
                const formatter = new IssueFormatter(message, {
                    id: consoleMessageStableId,
                    requestIdResolver: context.resolveCdpRequestId.bind(context),
                    elementIdResolver: context.resolveCdpElementId.bind(context),
                });
                if (!formatter.isValid()) {
                    throw new Error("Can't provide detals for the msgid " + consoleMessageStableId);
                }
                detailedConsoleMessage = formatter;
            }
        }
        let extensions;
        if (this.#listExtensions) {
            extensions = context.listExtensions();
        }
        let consoleMessages;
        if (this.#consoleDataOptions?.include) {
            let messages = context.getConsoleData(this.#consoleDataOptions.includePreservedMessages);
            if (this.#consoleDataOptions.types?.length) {
                const normalizedTypes = new Set(this.#consoleDataOptions.types);
                messages = messages.filter(message => {
                    if ('type' in message) {
                        return normalizedTypes.has(message.type());
                    }
                    if (message instanceof DevTools.AggregatedIssue) {
                        return normalizedTypes.has('issue');
                    }
                    return normalizedTypes.has('error');
                });
            }
            consoleMessages = (await Promise.all(messages.map(async (item) => {
                const consoleMessageStableId = context.getConsoleMessageStableId(item);
                if ('args' in item || item instanceof UncaughtError) {
                    const consoleMessage = item;
                    const devTools = context.getDevToolsUniverse();
                    return await ConsoleFormatter.from(consoleMessage, {
                        id: consoleMessageStableId,
                        fetchDetailedData: false,
                        devTools: devTools ?? undefined,
                    });
                }
                if (item instanceof DevTools.AggregatedIssue) {
                    const formatter = new IssueFormatter(item, {
                        id: consoleMessageStableId,
                    });
                    if (!formatter.isValid()) {
                        return null;
                    }
                    return formatter;
                }
                return null;
            }))).filter(item => item !== null);
        }
        let networkRequests;
        if (this.#networkRequestsOptions?.include) {
            let requests = context.getNetworkRequests(this.#networkRequestsOptions?.includePreservedRequests);
            // Apply resource type filtering if specified
            if (this.#networkRequestsOptions.resourceTypes?.length) {
                const normalizedTypes = new Set(this.#networkRequestsOptions.resourceTypes);
                requests = requests.filter(request => {
                    const type = request.resourceType();
                    return normalizedTypes.has(type);
                });
            }
            if (requests.length) {
                networkRequests = await Promise.all(requests.map(request => NetworkFormatter.from(request, {
                    requestId: context.getNetworkRequestStableId(request),
                    selectedInDevToolsUI: context.getNetworkRequestStableId(request) ===
                        this.#networkRequestsOptions?.networkRequestIdInDevToolsUI,
                    fetchData: false,
                    saveFile: (data, filename) => context.saveFile(data, filename),
                })));
            }
        }
        return this.format(toolName, context, {
            detailedConsoleMessage,
            consoleMessages,
            snapshot,
            detailedNetworkRequest,
            networkRequests,
            traceInsight: this.#attachedTraceInsight,
            traceSummary: this.#attachedTraceSummary,
            extensions,
        });
    }
    format(toolName, context, data) {
        const structuredContent = {};
        const response = [`# ${toolName} response`];
        if (this.#textResponseLines.length) {
            structuredContent.message = this.#textResponseLines.join('\n');
            response.push(...this.#textResponseLines);
        }
        const networkConditions = context.getNetworkConditions();
        if (networkConditions) {
            response.push(`## Network emulation`);
            response.push(`Emulating: ${networkConditions}`);
            response.push(`Default navigation timeout set to ${context.getNavigationTimeout()} ms`);
            structuredContent.networkConditions = networkConditions;
            structuredContent.navigationTimeout = context.getNavigationTimeout();
        }
        const viewport = context.getViewport();
        if (viewport) {
            response.push(`## Viewport emulation`);
            response.push(`Emulating viewport: ${JSON.stringify(viewport)}`);
            structuredContent.viewport = viewport;
        }
        const userAgent = context.getUserAgent();
        if (userAgent) {
            response.push(`## UserAgent emulation`);
            response.push(`Emulating userAgent: ${userAgent}`);
            structuredContent.userAgent = userAgent;
        }
        const cpuThrottlingRate = context.getCpuThrottlingRate();
        if (cpuThrottlingRate > 1) {
            response.push(`## CPU emulation`);
            response.push(`Emulating: ${cpuThrottlingRate}x slowdown`);
            structuredContent.cpuThrottlingRate = cpuThrottlingRate;
        }
        const colorScheme = context.getColorScheme();
        if (colorScheme) {
            response.push(`## Color Scheme emulation`);
            response.push(`Emulating: ${colorScheme}`);
            structuredContent.colorScheme = colorScheme;
        }
        const dialog = context.getDialog();
        if (dialog) {
            const defaultValueIfNeeded = dialog.type() === 'prompt'
                ? ` (default value: "${dialog.defaultValue()}")`
                : '';
            response.push(`# Open dialog
${dialog.type()}: ${dialog.message()}${defaultValueIfNeeded}.
Call ${handleDialog.name} to handle it before continuing.`);
            structuredContent.dialog = {
                type: dialog.type(),
                message: dialog.message(),
                defaultValue: dialog.defaultValue(),
            };
        }
        if (this.#includePages) {
            const parts = [`## Pages`];
            for (const page of context.getPages()) {
                parts.push(`${context.getPageId(page)}: ${page.url()}${context.isPageSelected(page) ? ' [selected]' : ''}`);
            }
            response.push(...parts);
            structuredContent.pages = context.getPages().map(page => {
                return {
                    id: context.getPageId(page),
                    url: page.url(),
                    selected: context.isPageSelected(page),
                };
            });
        }
        if (this.#tabId) {
            structuredContent.tabId = this.#tabId;
        }
        if (data.traceSummary) {
            const summary = getTraceSummary(data.traceSummary);
            response.push(summary);
            structuredContent.traceSummary = summary;
            structuredContent.traceInsights = [];
            for (const insightSet of data.traceSummary.insights?.values() ?? []) {
                for (const [insightName, model] of Object.entries(insightSet.model)) {
                    structuredContent.traceInsights.push({
                        insightName,
                        insightKey: model.insightKey,
                    });
                }
            }
        }
        if (data.traceInsight) {
            const insightOutput = getInsightOutput(data.traceInsight.trace, data.traceInsight.insightSetId, data.traceInsight.insightName);
            if ('error' in insightOutput) {
                response.push(insightOutput.error);
            }
            else {
                response.push(insightOutput.output);
            }
        }
        if (data.snapshot) {
            if (typeof data.snapshot === 'string') {
                response.push(`Saved snapshot to ${data.snapshot}.`);
                structuredContent.snapshotFilePath = data.snapshot;
            }
            else {
                response.push('## Latest page snapshot');
                response.push(data.snapshot.toString());
                structuredContent.snapshot = data.snapshot.toJSON();
            }
        }
        if (data.detailedNetworkRequest) {
            response.push(data.detailedNetworkRequest.toStringDetailed());
            structuredContent.networkRequest =
                data.detailedNetworkRequest.toJSONDetailed();
        }
        if (data.detailedConsoleMessage) {
            response.push(data.detailedConsoleMessage.toStringDetailed());
            structuredContent.consoleMessage =
                data.detailedConsoleMessage.toJSONDetailed();
        }
        if (data.extensions) {
            structuredContent.extensions = data.extensions;
            response.push('## Extensions');
            if (data.extensions.length === 0) {
                response.push('No extensions installed.');
            }
            else {
                const extensionsMessage = data.extensions
                    .map(extension => {
                    return `id=${extension.id} "${extension.name}" v${extension.version} ${extension.isEnabled ? 'Enabled' : 'Disabled'}`;
                })
                    .join('\n');
                response.push(extensionsMessage);
            }
        }
        if (this.#networkRequestsOptions?.include) {
            let requests = context.getNetworkRequests(this.#networkRequestsOptions?.includePreservedRequests);
            // Apply resource type filtering if specified
            if (this.#networkRequestsOptions.resourceTypes?.length) {
                const normalizedTypes = new Set(this.#networkRequestsOptions.resourceTypes);
                requests = requests.filter(request => {
                    const type = request.resourceType();
                    return normalizedTypes.has(type);
                });
            }
            response.push('## Network requests');
            if (requests.length) {
                const paginationData = this.#dataWithPagination(requests, this.#networkRequestsOptions.pagination);
                structuredContent.pagination = paginationData.pagination;
                response.push(...paginationData.info);
                if (data.networkRequests) {
                    structuredContent.networkRequests = [];
                    for (const formatter of data.networkRequests) {
                        response.push(formatter.toString());
                        structuredContent.networkRequests.push(formatter.toJSON());
                    }
                }
            }
            else {
                response.push('No requests found.');
            }
        }
        if (this.#consoleDataOptions?.include) {
            const messages = data.consoleMessages ?? [];
            response.push('## Console messages');
            if (messages.length) {
                const paginationData = this.#dataWithPagination(messages, this.#consoleDataOptions.pagination);
                structuredContent.pagination = paginationData.pagination;
                response.push(...paginationData.info);
                response.push(...paginationData.items.map(message => message.toString()));
                structuredContent.consoleMessages = paginationData.items.map(message => message.toJSON());
            }
            else {
                response.push('<no console messages found>');
            }
        }
        const text = {
            type: 'text',
            text: response.join('\n'),
        };
        const images = this.#images.map(imageData => {
            return {
                type: 'image',
                ...imageData,
            };
        });
        return {
            content: [text, ...images],
            structuredContent,
        };
    }
    #dataWithPagination(data, pagination) {
        const response = [];
        const paginationResult = paginate(data, pagination);
        if (paginationResult.invalidPage) {
            response.push('Invalid page number provided. Showing first page.');
        }
        const { startIndex, endIndex, currentPage, totalPages } = paginationResult;
        response.push(`Showing ${startIndex + 1}-${endIndex} of ${data.length} (Page ${currentPage + 1} of ${totalPages}).`);
        if (pagination) {
            if (paginationResult.hasNextPage) {
                response.push(`Next page: ${currentPage + 1}`);
            }
            if (paginationResult.hasPreviousPage) {
                response.push(`Previous page: ${currentPage - 1}`);
            }
        }
        return {
            info: response,
            items: paginationResult.items,
            pagination: {
                currentPage: paginationResult.currentPage,
                totalPages: paginationResult.totalPages,
                hasNextPage: paginationResult.hasNextPage,
                hasPreviousPage: paginationResult.hasPreviousPage,
                startIndex: paginationResult.startIndex,
                endIndex: paginationResult.endIndex,
                invalidPage: paginationResult.invalidPage,
            },
        };
    }
    resetResponseLineForTesting() {
        this.#textResponseLines = [];
    }
}
