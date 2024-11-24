/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { Location } from 'vscode-languageserver';
import type { TextDocument, Position } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import { NodeType } from '../types/nodes';
import type { IDocument, IDocumentSymbols, ISymbols } from '../types/symbols';
import type StorageService from '../services/storage';

import { parseDocument } from '../services/parser';
import { getSymbolsRelatedToDocument } from '../utils/symbols';
import { getDocumentPath } from '../utils/document';
import { uriToFsPath } from '../utils/fs';

interface ISymbol {
	document: string | undefined;
	path: string;
	info: any;
}

interface IIdentifier {
	type: keyof ISymbols;
	position: Position;
	name: string;
}

function samePosition(a: Position | undefined, b: Position): boolean {
	if (a === undefined) {
		return false;
	}

	return a.line === b.line && a.character === b.character;
}

/**
 * Returns the Symbol, if it present in the documents.
 */
function getSymbols(symbolList: IDocumentSymbols[], identifier: IIdentifier, currentPath: string): ISymbol[] {
	const list: ISymbol[] = [];

	for (const symbols of symbolList) {
		const fsPath = getDocumentPath(currentPath, symbols.document);

		if (identifier.type === 'imports') {
			continue;
		}

		for (const item of symbols[identifier.type]) {
			if (item.name === identifier.name && !samePosition(item.position, identifier.position)) {
				list.push({
					document: symbols.filepath,
					path: fsPath,
					info: item,
				});
			}
		}
	}

	return list;
}

export async function goDefinition(
	document: TextDocument,
	offset: number,
	storage: StorageService
): Promise<Location | null> {
	const resource = await parseDocument(document, offset);
	const hoverNode = resource.node;
	if (!hoverNode || !hoverNode.type) {
		return null;
	}

	let identifier: IIdentifier | null = null;
	if (hoverNode.type === NodeType.VariableName) {
		const parent = hoverNode.getParent();
		if (parent.type !== NodeType.FunctionParameter && parent.type !== NodeType.VariableDeclaration) {
			identifier = {
				name: hoverNode.getName(),
				position: document.positionAt(hoverNode.offset),
				type: 'variables',
			};
		}
	} else if (hoverNode.type === NodeType.Identifier) {
		let i = 0;
		let node = hoverNode;
		while (node.type !== NodeType.MixinReference && node.type !== NodeType.Function && i !== 2) {
			node = node.getParent();
			i++;
		}

		if (node && (node.type === NodeType.MixinReference || node.type === NodeType.Function)) {
			let type: keyof ISymbols = 'mixins';
			if (node.type === NodeType.Function) {
				type = 'functions';
			}

			identifier = {
				name: node.getName(),
				position: document.positionAt(node.offset),
				type,
			};
		}
	}

	if (identifier) {
		return goIdentifier(document, resource, storage, identifier);
	}

	return null;
}

async function goIdentifier(
	document: TextDocument,
	resource: IDocument,
	storage: StorageService,
	identifier: IIdentifier
) {
	if (resource.symbols.document !== undefined) {
		storage.set(document.uri, resource.symbols);
	}

	const documentPath = uriToFsPath(document.uri);

	const symbolsList = getSymbolsRelatedToDocument(storage, documentPath);

	// Symbols
	const candidates = getSymbols(symbolsList, identifier, documentPath);
	if (candidates.length === 0) {
		return null;
	}

	const definition = candidates[0];

	if (definition?.document === undefined) {
		return null;
	}

	const symbol = Location.create(URI.file(definition.document).toString(), {
		start: definition.info.position,
		end: {
			line: definition.info.position.line,
			character: definition.info.position.character + definition.info.name.length,
		},
	});

	return symbol;
}
