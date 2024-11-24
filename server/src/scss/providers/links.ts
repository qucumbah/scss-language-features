/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { DocumentLink } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import { INode, NodeType } from '../types/nodes';
import type { IDocument } from '../types/symbols';
import type StorageService from '../services/storage';

import { parseDocument } from '../services/parser';
import { resolveAliasedPath } from '../utils/aliasedPath';
import { uriToFsPath } from '../utils/fs';

export async function links(document: TextDocument, storage: StorageService): Promise<DocumentLink[]> {
	const resource = await parseDocument(document);

	const linkNodes = await findLinkNodes(resource);
	if (!linkNodes.length) {
		return [];
	}

	const tsConfig = storage.getAssociatedTsConfig(document.uri);

	return linkNodes.map((node) => {
		const importPath = node.getText().slice(1, -1);
		const documentPath = uriToFsPath(document.uri);
		const resolvedPath = resolveAliasedPath(importPath, documentPath, tsConfig);
		return {
			target: resolvedPath + '.scss',
			range: {
				start: document.positionAt(node.offset),
				end: document.positionAt(node.end),
			},
		};
	});
}

async function findLinkNodes(textDocument: IDocument): Promise<INode[]> {
	const result: INode[] = [];
	for (const node of textDocument.ast.getChildren()) {
		if (node.type === NodeType.Use && node.getChild(0).type === NodeType.StringLiteral) {
			result.push(node.getChild(0));
		}
	}

	return result;
}
