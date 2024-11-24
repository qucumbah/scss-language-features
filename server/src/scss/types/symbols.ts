/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import type { Position } from 'vscode-languageserver-textdocument';
import type { INode } from './nodes';

export interface IVariable {
	position?: Position;
	mixin?: string;
	name: string;
	value: string | null;
	offset: number;
}

export interface IMixin {
	position?: Position;
	name: string;
	parameters: IVariable[];
	offset: number;
}

export type IFunction = IMixin;

export interface IImport {
	reference?: boolean;
	filepath: string;
	dynamic: boolean;
	css: boolean;
}

export interface IPathShorthand {
	alias: string;
	paths: string[];
}

export interface IDocumentSymbols extends ISymbols {
	/**
	 * The imported path in the document.
	 */
	document?: string;
	/**
	 * The real path to the file on the file system.
	 */
	filepath?: string;
}

export interface ISymbols {
	variables: IVariable[];
	mixins: IMixin[];
	functions: IFunction[];
	imports: IImport[];
}

export interface IDocument {
	node: INode | null;
	ast: INode;
	symbols: IDocumentSymbols;
}

export interface ITsConfig {
	filepath: string;
	paths?: IPathShorthand[];
}
