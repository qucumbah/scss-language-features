/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Connection,
	TextDocuments,
	InitializeParams,
	InitializeResult,
	ServerCapabilities,
	ConfigurationRequest,
	WorkspaceFolder,
	TextDocumentSyncKind,
	NotificationType,
	Disposable,
	TextDocumentIdentifier,
	Range,
	FormattingOptions,
	TextEdit,
	Diagnostic,
	CompletionParams,
	FileEvent,
	FileChangeType,
	CompletionList,
	Location,
	DefinitionParams,
	DocumentLink,
	DocumentLinkParams,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import {
	getCSSLanguageService,
	getSCSSLanguageService,
	getLESSLanguageService,
	LanguageSettings,
	LanguageService,
	Stylesheet,
	TextDocument,
	Position,
} from 'vscode-css-languageservice';
import { getLanguageModelCache } from './languageModelCache';
import { runSafeAsync } from './utils/runner';
import { DiagnosticsSupport, registerDiagnosticsPullSupport, registerDiagnosticsPushSupport } from './utils/validation';
import { getDocumentContext } from './utils/documentContext';
import { fetchDataProviders } from './customData';
import { RequestService, getRequestService } from './requests';
import { getSCSSRegionsDocument } from './scss/utils/vue';
import { doCompletion } from './scss/providers/completion';
import StorageService from './scss/services/storage';
import ScannerService from './scss/services/scanner';
import { findFiles, uriToFsPath } from './scss/utils/fs';
import path from 'path';
import { goDefinition } from './scss/providers/goDefinition';
import { links } from './scss/providers/links';

namespace CustomDataChangedNotification {
	export const type: NotificationType<string[]> = new NotificationType('css/customDataChanged');
}

export interface Settings {
	css: LanguageSettings;
	less: LanguageSettings;
	scss: LanguageSettings;
}

export interface RuntimeEnvironment {
	readonly file?: RequestService;
	readonly http?: RequestService;
	readonly timer: {
		setImmediate(callback: (...args: any[]) => void, ...args: any[]): Disposable;
		setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): Disposable;
	};
}

const settings = {
	scannerDepth: 32,
	scannerExclude: ['node_modules'],
	scanImportedFiles: true,
	implicitlyLabel: null,
	showErrors: true,
	suggestVariables: true,
	suggestMixins: true,
	suggestFunctions: true,
	suggestFunctionsInStringContextAfterSymbols: '',
};

const getServices = async ({ workspaceRoot, connection }: { workspaceRoot: string; connection: Connection }) => {
	const storageService = new StorageService();
	const scannerService = new ScannerService(storageService, settings);

	const scannerSettings = {
		cwd: uriToFsPath(workspaceRoot),
		deep: settings.scannerDepth,
		ignore: settings.scannerExclude,
	};
	const scssFiles = (await findFiles('**/*.scss', scannerSettings)).map(uriToFsPath);
	const tsConfigFiles = (await findFiles('**/tsconfig.json', scannerSettings)).map(uriToFsPath);

	try {
		await scannerService.scanScssFiles(scssFiles);
		await Promise.all(tsConfigFiles.map((tsConfigFile) => scannerService.addTsConfigFile(tsConfigFile)));
	} catch (error) {
		if (settings.showErrors) {
			connection.window.showErrorMessage(String(error));
		}
	}

	return { scannerService, storageService };
};

export function startServer(connection: Connection, runtime: RuntimeEnvironment) {
	// Create a text document manager.
	const documents = new TextDocuments(TextDocument);
	// Make the text document manager listen on the connection
	// for open, change and close text document events
	documents.listen(connection);

	const stylesheets = getLanguageModelCache<Stylesheet>(10, 60, (document) =>
		getLanguageService(document).parseStylesheet(document)
	);
	documents.onDidClose((e) => {
		stylesheets.onDocumentRemoved(e.document);
	});
	connection.onShutdown(() => {
		stylesheets.dispose();
	});

	let scopedSettingsSupport = false;
	let foldingRangeLimit = Number.MAX_VALUE;
	let workspaceFolders: WorkspaceFolder[];
	let formatterMaxNumberOfEdits = Number.MAX_VALUE;

	let workspaceRoot: string;
	let scannerService: ScannerService;
	let storageService: StorageService;

	let dataProvidersReady: Promise<any> = Promise.resolve();

	let diagnosticsSupport: DiagnosticsSupport | undefined;

	const languageServices: { [id: string]: LanguageService } = {};

	const notReady = () => Promise.reject('Not Ready');
	let requestService: RequestService = { getContent: notReady, stat: notReady, readDirectory: notReady };

	// After the server has started the client sends an initialize request. The server receives
	// in the passed params the rootPath of the workspace plus the client capabilities.
	connection.onInitialize((params: InitializeParams): InitializeResult => {
		const initializationOptions = (params.initializationOptions as any) || {};

		workspaceFolders = (<any>params).workspaceFolders;

		workspaceRoot = workspaceFolders[0].uri;
		getServices({ connection, workspaceRoot }).then((result) => {
			scannerService = result.scannerService;
			storageService = result.storageService;
		});

		if (!Array.isArray(workspaceFolders)) {
			workspaceFolders = [];
			if (params.rootPath) {
				workspaceFolders.push({ name: '', uri: URI.file(params.rootPath).toString(true) });
			}
		}

		requestService = getRequestService(initializationOptions?.handledSchemas || ['file'], connection, runtime);

		function getClientCapability<T>(name: string, def: T) {
			const keys = name.split('.');
			let c: any = params.capabilities;
			for (let i = 0; c && i < keys.length; i++) {
				if (!c.hasOwnProperty(keys[i])) {
					return def;
				}
				c = c[keys[i]];
			}
			return c;
		}
		const snippetSupport = !!getClientCapability('textDocument.completion.completionItem.snippetSupport', false);
		scopedSettingsSupport = !!getClientCapability('workspace.configuration', false);
		foldingRangeLimit = getClientCapability('textDocument.foldingRange.rangeLimit', Number.MAX_VALUE);

		formatterMaxNumberOfEdits =
			initializationOptions?.customCapabilities?.rangeFormatting?.editLimit || Number.MAX_VALUE;

		languageServices.css = getCSSLanguageService({
			fileSystemProvider: requestService,
			clientCapabilities: params.capabilities,
		});
		languageServices.scss = getSCSSLanguageService({
			fileSystemProvider: requestService,
			clientCapabilities: params.capabilities,
		});
		languageServices.less = getLESSLanguageService({
			fileSystemProvider: requestService,
			clientCapabilities: params.capabilities,
		});

		const supportsDiagnosticPull = getClientCapability('textDocument.diagnostic', undefined);
		if (supportsDiagnosticPull === undefined) {
			diagnosticsSupport = registerDiagnosticsPushSupport(documents, connection, runtime, validateTextDocument);
		} else {
			diagnosticsSupport = registerDiagnosticsPullSupport(documents, connection, runtime, validateTextDocument);
		}

		const capabilities: ServerCapabilities = {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: snippetSupport ? { resolveProvider: false, triggerCharacters: ['/', '-', ':'] } : undefined,
			hoverProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			definitionProvider: true,
			documentHighlightProvider: true,
			documentLinkProvider: {
				resolveProvider: false,
				workDoneProgress: false,
			},
			codeActionProvider: true,
			renameProvider: true,
			colorProvider: {},
			foldingRangeProvider: true,
			selectionRangeProvider: true,
			diagnosticProvider: {
				documentSelector: null,
				interFileDependencies: false,
				workspaceDiagnostics: false,
			},
			documentRangeFormattingProvider: initializationOptions?.provideFormatter === true,
			documentFormattingProvider: initializationOptions?.provideFormatter === true,
		};
		return { capabilities };
	});

	function getLanguageService(document: TextDocument) {
		let service = languageServices[document.languageId];
		if (!service) {
			connection.console.log('Document type is ' + document.languageId + ', using css instead.');
			service = languageServices['css'];
		}
		return service;
	}

	let documentSettings: { [key: string]: Thenable<LanguageSettings | undefined> } = {};
	// remove document settings on close
	documents.onDidClose((e) => {
		delete documentSettings[e.document.uri];
	});
	function getDocumentSettings(textDocument: TextDocument): Thenable<LanguageSettings | undefined> {
		if (scopedSettingsSupport) {
			let promise = documentSettings[textDocument.uri];
			if (!promise) {
				const configRequestParam = { items: [{ scopeUri: textDocument.uri, section: textDocument.languageId }] };
				promise = connection
					.sendRequest(ConfigurationRequest.type, configRequestParam)
					.then((s) => s[0] as LanguageSettings | undefined);
				documentSettings[textDocument.uri] = promise;
			}
			return promise;
		}
		return Promise.resolve(undefined);
	}

	// The settings have changed. Is send on server activation as well.
	connection.onDidChangeConfiguration((change) => {
		updateConfiguration(change.settings as any);
	});

	connection.onDidChangeWatchedFiles((event) => {
		const tsConfigChanges: FileEvent[] = [];
		const scssChanges: FileEvent[] = [];

		for (const file of event.changes) {
			if (path.basename(file.uri) === 'tsconfig.json') {
				tsConfigChanges.push(file);
			}

			if (path.extname(file.uri) === '.scss') {
				scssChanges.push(file);
			}
		}

		for (const tsConfigChange of tsConfigChanges) {
			const tsConfigPath = uriToFsPath(tsConfigChange.uri);
			switch (tsConfigChange.type) {
				case FileChangeType.Created:
					scannerService.addTsConfigFile(tsConfigPath);
					break;
				case FileChangeType.Changed:
					scannerService.updateTsConfigFile(tsConfigPath);
					break;
				case FileChangeType.Deleted:
					scannerService.deleteTsConfigFile(uriToFsPath(tsConfigPath), workspaceRoot);
					break;
			}
		}

		return scannerService.scanScssFiles(scssChanges.map((file) => uriToFsPath(file.uri)));
	});

	function updateConfiguration(settings: any) {
		for (const languageId in languageServices) {
			languageServices[languageId].configure(settings[languageId]);
		}
		// reset all document settings
		documentSettings = {};
		diagnosticsSupport?.requestRefresh();
	}

	async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
		const settingsPromise = getDocumentSettings(textDocument);
		const [settings] = await Promise.all([settingsPromise, dataProvidersReady]);

		const stylesheet = stylesheets.get(textDocument);
		return getLanguageService(textDocument).doValidation(textDocument, stylesheet, settings);
	}

	function updateDataProviders(dataPaths: string[]) {
		dataProvidersReady = fetchDataProviders(dataPaths, requestService).then((customDataProviders) => {
			for (const lang in languageServices) {
				languageServices[lang].setDataProviders(true, customDataProviders);
			}
		});
	}

	const tryGetScssCompletions = async (textDocumentPosition: CompletionParams): Promise<CompletionList | null> => {
		if (!storageService) {
			return null;
		}

		const uri = documents.get(textDocumentPosition.textDocument.uri);
		if (uri === undefined) {
			return null;
		}

		const { document, offset } = getSCSSRegionsDocument(uri, textDocumentPosition.position);
		if (!document) {
			return null;
		}

		const result = await doCompletion(document, offset, settings, storageService);

		return result;
	};

	connection.onCompletion((textDocumentPosition, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const scssCompletions = await tryGetScssCompletions(textDocumentPosition);
				if (scssCompletions?.items.length) {
					return scssCompletions;
				}
				const document = documents.get(textDocumentPosition.textDocument.uri);
				if (document) {
					const [settings] = await Promise.all([getDocumentSettings(document), dataProvidersReady]);
					const styleSheet = stylesheets.get(document);
					const documentContext = getDocumentContext(document.uri, workspaceFolders);
					return getLanguageService(document).doComplete2(
						document,
						textDocumentPosition.position,
						styleSheet,
						documentContext,
						settings?.completion
					);
				}
				return null;
			},
			null,
			`Error while computing completions for ${textDocumentPosition.textDocument.uri}`,
			token
		);
	});

	connection.onHover((textDocumentPosition, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(textDocumentPosition.textDocument.uri);
				if (document) {
					const [settings] = await Promise.all([getDocumentSettings(document), dataProvidersReady]);
					const styleSheet = stylesheets.get(document);
					return getLanguageService(document).doHover(
						document,
						textDocumentPosition.position,
						styleSheet,
						settings?.hover
					);
				}
				return null;
			},
			null,
			`Error while computing hover for ${textDocumentPosition.textDocument.uri}`,
			token
		);
	});

	connection.onDocumentSymbol((documentSymbolParams, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(documentSymbolParams.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).findDocumentSymbols2(document, stylesheet);
				}
				return [];
			},
			[],
			`Error while computing document symbols for ${documentSymbolParams.textDocument.uri}`,
			token
		);
	});

	const tryGetScssDefinitions = async (textDocumentPosition: DefinitionParams): Promise<Location | null> => {
		if (!storageService) {
			return null;
		}

		const uri = documents.get(textDocumentPosition.textDocument.uri);
		if (uri === undefined) {
			return null;
		}

		const { document, offset } = getSCSSRegionsDocument(uri, textDocumentPosition.position);
		if (!document) {
			return null;
		}

		const result = await goDefinition(document, offset, storageService);
		return result;
	};

	connection.onDefinition((documentDefinitionParams, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const scssDefinitions = await tryGetScssDefinitions(documentDefinitionParams);
				if (scssDefinitions) {
					return scssDefinitions;
				}
				const document = documents.get(documentDefinitionParams.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).findDefinition(document, documentDefinitionParams.position, stylesheet);
				}
				return null;
			},
			null,
			`Error while computing definitions for ${documentDefinitionParams.textDocument.uri}`,
			token
		);
	});

	connection.onDocumentHighlight((documentHighlightParams, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(documentHighlightParams.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).findDocumentHighlights(
						document,
						documentHighlightParams.position,
						stylesheet
					);
				}
				return [];
			},
			[],
			`Error while computing document highlights for ${documentHighlightParams.textDocument.uri}`,
			token
		);
	});

	const tryGetScssLinks = async (textDocumentPosition: DocumentLinkParams): Promise<DocumentLink[]> => {
		if (!storageService) {
			return [];
		}

		const document = documents.get(textDocumentPosition.textDocument.uri);
		if (document === undefined) {
			return [];
		}

		const result = await links(document, storageService);
		return result;
	};

	connection.onDocumentLinks(async (documentLinkParams, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const scssLinks = await tryGetScssLinks(documentLinkParams);
				if (scssLinks && scssLinks.length) {
					return scssLinks;
				}
				const document = documents.get(documentLinkParams.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const documentContext = getDocumentContext(document.uri, workspaceFolders);
					const stylesheet = stylesheets.get(document);
					const result = getLanguageService(document).findDocumentLinks2(document, stylesheet, documentContext);
					return result;
				}
				return [];
			},
			[],
			`Error while computing document links for ${documentLinkParams.textDocument.uri}`,
			token
		);
	});

	connection.onReferences((referenceParams, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(referenceParams.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).findReferences(document, referenceParams.position, stylesheet);
				}
				return [];
			},
			[],
			`Error while computing references for ${referenceParams.textDocument.uri}`,
			token
		);
	});

	connection.onCodeAction((codeActionParams, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(codeActionParams.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).doCodeActions(
						document,
						codeActionParams.range,
						codeActionParams.context,
						stylesheet
					);
				}
				return [];
			},
			[],
			`Error while computing code actions for ${codeActionParams.textDocument.uri}`,
			token
		);
	});

	connection.onDocumentColor((params, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(params.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).findDocumentColors(document, stylesheet);
				}
				return [];
			},
			[],
			`Error while computing document colors for ${params.textDocument.uri}`,
			token
		);
	});

	connection.onColorPresentation((params, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(params.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).getColorPresentations(document, stylesheet, params.color, params.range);
				}
				return [];
			},
			[],
			`Error while computing color presentations for ${params.textDocument.uri}`,
			token
		);
	});

	connection.onRenameRequest((renameParameters, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(renameParameters.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).doRename(
						document,
						renameParameters.position,
						renameParameters.newName,
						stylesheet
					);
				}
				return null;
			},
			null,
			`Error while computing renames for ${renameParameters.textDocument.uri}`,
			token
		);
	});

	connection.onFoldingRanges((params, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(params.textDocument.uri);
				if (document) {
					await dataProvidersReady;
					return getLanguageService(document).getFoldingRanges(document, { rangeLimit: foldingRangeLimit });
				}
				return null;
			},
			null,
			`Error while computing folding ranges for ${params.textDocument.uri}`,
			token
		);
	});

	connection.onSelectionRanges((params, token) => {
		return runSafeAsync(
			runtime,
			async () => {
				const document = documents.get(params.textDocument.uri);
				const positions: Position[] = params.positions;

				if (document) {
					await dataProvidersReady;
					const stylesheet = stylesheets.get(document);
					return getLanguageService(document).getSelectionRanges(document, positions, stylesheet);
				}
				return [];
			},
			[],
			`Error while computing selection ranges for ${params.textDocument.uri}`,
			token
		);
	});

	async function onFormat(
		textDocument: TextDocumentIdentifier,
		range: Range | undefined,
		options: FormattingOptions
	): Promise<TextEdit[]> {
		const document = documents.get(textDocument.uri);
		if (document) {
			const edits = getLanguageService(document).format(document, range ?? getFullRange(document), options);
			if (edits.length > formatterMaxNumberOfEdits) {
				const newText = TextDocument.applyEdits(document, edits);
				return [TextEdit.replace(getFullRange(document), newText)];
			}
			return edits;
		}
		return [];
	}

	connection.onDocumentRangeFormatting((formatParams, token) => {
		return runSafeAsync(
			runtime,
			() => onFormat(formatParams.textDocument, formatParams.range, formatParams.options),
			[],
			`Error while formatting range for ${formatParams.textDocument.uri}`,
			token
		);
	});

	connection.onDocumentFormatting((formatParams, token) => {
		return runSafeAsync(
			runtime,
			() => onFormat(formatParams.textDocument, undefined, formatParams.options),
			[],
			`Error while formatting ${formatParams.textDocument.uri}`,
			token
		);
	});

	connection.onNotification(CustomDataChangedNotification.type, updateDataProviders);

	// Listen on the connection
	connection.listen();
}

function getFullRange(document: TextDocument): Range {
	return Range.create(Position.create(0, 0), document.positionAt(document.getText().length));
}
