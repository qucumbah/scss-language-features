/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { SymbolKind, DocumentLink } from 'vscode-css-languageservice';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';

import { INode, NodeType } from '../types/nodes';
import type {
	IDocument,
	IDocumentSymbols,
	IVariable,
	IImport,
	ITsConfig,
} from '../types/symbols';
import { getNodeAtOffset, getParentNodeByType } from '../utils/ast';
import { buildDocumentContext } from '../utils/document';
import { getLanguageService } from '../language-service';
import { readFile, uriToFsPath } from '../utils/fs';

const reDynamicPath = /[#{}\*]/;

const ls = getLanguageService();

/**
 * Returns all Symbols in a single document.
 */
export async function parseDocument(
	document: TextDocument,
	offset: number | null = null
): Promise<IDocument> {
	const documentPath = uriToFsPath(document.uri);
	const ast = ls.parseStylesheet(document) as INode;

	const symbols: IDocumentSymbols = {
		document: documentPath,
		filepath: documentPath,
		...(await findDocumentSymbols(document, ast)),
	};

	return {
		node: getNodeAtOffset(ast, offset),
		ast,
		symbols,
	};
}

export async function parseTsConfig(filepath: string): Promise<ITsConfig> {
	const contents = await readFile(filepath);

	try {
		const json = JSON.parse(contents);

		const result = {
			filepath,
			paths: Object.entries<string[]>(json.compilerOptions?.paths || {}).map(
				([alias, paths]) => ({
					alias: alias.replace(/\*$/, ''),
					paths: paths.map((path) => path.replace(/\*$/, '')),
				})
			),
		};

		// Technically, this is a bit broken since if the extension changes, the current config will not
		// update automatically. But it is good enough for now.
		if (json.extends && json.extends.startsWith('.')) {
			const extensionPath = path.join(path.dirname(filepath), json.extends);
			const extension = await parseTsConfig(extensionPath);
			if (extension.paths) {
				result.paths = [...result.paths, ...extension.paths];
			}
		}

		return result;
	} catch {
		return {
			filepath,
			paths: undefined,
		};
	}
}

async function findDocumentSymbols(
	document: TextDocument,
	ast: INode
): Promise<IDocumentSymbols> {
	const symbols = ls.findDocumentSymbols(document, ast);
	const links = await findDocumentLinks(document, ast);

	const result: IDocumentSymbols = {
		functions: [],
		imports: convertLinksToImports(links),
		mixins: [],
		variables: [],
	};

	for (const symbol of symbols) {
		const position = symbol.location.range.start;
		const offset = document.offsetAt(symbol.location.range.start);

		if (symbol.kind === SymbolKind.Variable) {
			result.variables.push({
				name: symbol.name,
				offset,
				position,
				value: getVariableValue(ast, offset),
			});
		} else if (symbol.kind === SymbolKind.Method) {
			result.mixins.push({
				name: symbol.name,
				offset,
				position,
				parameters: getMethodParameters(ast, offset),
			});
		} else if (symbol.kind === SymbolKind.Function) {
			result.functions.push({
				name: symbol.name,
				offset,
				position,
				parameters: getMethodParameters(ast, offset),
			});
		}
	}

	return result;
}

async function findDocumentLinks(
	document: TextDocument,
	ast: INode
): Promise<DocumentLink[]> {
	const links = await ls.findDocumentLinks2(
		document,
		ast,
		buildDocumentContext(document.uri)
	);

	const result: DocumentLink[] = [];

	for (const link of links) {
		if (link.target !== undefined && link.target !== '') {
			result.push({
				...link,
				target: uriToFsPath(link.target),
			});
		}
	}

	return result;
}

function getVariableValue(ast: INode, offset: number): string | null {
	const node = getNodeAtOffset(ast, offset);

	if (node === null) {
		return null;
	}

	const parent = getParentNodeByType(node, NodeType.VariableDeclaration);

	return parent?.getValue()?.getText() || null;
}

function getMethodParameters(ast: INode, offset: number): IVariable[] {
	const node = getNodeAtOffset(ast, offset);

	if (node === null) {
		return [];
	}

	return node
		.getParameters()
		.getChildren()
		.map((child) => {
			const defaultValueNode = child.getDefaultValue();

			const value =
				defaultValueNode === undefined ? null : defaultValueNode.getText();

			return {
				name: child.getName(),
				offset: child.offset,
				value,
			};
		});
}

export function convertLinksToImports(links: DocumentLink[]): IImport[] {
	const result: IImport[] = [];

	for (const link of links) {
		if (link.target !== undefined) {
			result.push({
				filepath: link.target,
				dynamic: reDynamicPath.test(link.target),
				css: link.target.endsWith('.css'),
			});
		}
	}

	return result;
}
