/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'path';

import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import type { ISettings } from '../types/settings';
import {
	readFile,
	fileExists,
	isDescendant,
	findFileInParents,
	fsPathToUri,
} from '../utils/fs';
import { parseDocument, parseTsConfig } from './parser';
import type StorageService from './storage';

export default class ScannerService {
	constructor(
		private readonly _storage: StorageService,
		private readonly _settings: ISettings
	) {}

	public async addTsConfigFile(tsConfigPath: string): Promise<void> {
		const tsConfig = await parseTsConfig(tsConfigPath);

		const tsConfigUri = fsPathToUri(tsConfigPath);
		this._storage.setTsConfig(tsConfigUri, tsConfig);

		for (const scssUri of this._storage.keys()) {
			// Potential performance hit, profile
			if (isDescendant(scssUri, path.dirname(tsConfigPath))) {
				if (tsConfigUri) {
					this._storage.associate(scssUri, tsConfigUri);
				} else {
					this._storage.desociate(scssUri);
				}
			}
		}
	}

	public async deleteTsConfigFile(
		tsConfigPath: string,
		workspaceDir: string
	): Promise<void> {
		const tsConfigUri = fsPathToUri(tsConfigPath);
		this._storage.deleteTsConfig(tsConfigUri);

		const newTsConfigPath = await findFileInParents(
			'tsconfig.json',
			path.dirname(path.dirname(tsConfigPath)),
			workspaceDir
		);
		const newTsConfigUri = newTsConfigPath
			? fsPathToUri(newTsConfigPath)
			: undefined;

		for (const scssPath of this._storage.keys()) {
			// Potential performance hit, investigate
			if (isDescendant(scssPath, tsConfigPath)) {
				if (newTsConfigUri) {
					this._storage.associate(scssPath, newTsConfigUri);
				} else {
					this._storage.desociate(scssPath);
				}
			}
		}
	}

	public async updateTsConfigFile(tsConfigPath: string): Promise<void> {
		const newTsConfig = await parseTsConfig(tsConfigPath);

		const tsConfigUri = fsPathToUri(tsConfigPath);
		const oldTsConfig = this._storage.getTsConfig(tsConfigUri);

		if (!oldTsConfig) {
			return;
		}

		oldTsConfig.paths = newTsConfig.paths;
	}

	public async scanScssFiles(files: string[]): Promise<void> {
		const iterator = new Set(files);

		for (let filepath of iterator) {
			// Cast to the system file path style
			filepath = path.normalize(filepath);

			const uri = URI.file(filepath).toString();

			const isExistFile = await this._fileExists(filepath);

			if (!isExistFile) {
				this._storage.delete(uri);

				continue;
			}

			const content = await this._readFile(filepath);
			const document = TextDocument.create(uri, 'scss', 1, content);
			const { symbols } = await parseDocument(document, null);

			const storageValue = {
				...symbols,
				filepath,
			};
			this._storage.set(uri, storageValue);

			if (!this._settings.scanImportedFiles) {
				continue;
			}

			for (const symbol of symbols.imports) {
				if (symbol.dynamic || symbol.css) {
					continue;
				}

				iterator.add(symbol.filepath);
			}
		}
	}

	protected _readFile(filepath: string): Promise<string> {
		return readFile(filepath);
	}

	protected _fileExists(filepath: string): Promise<boolean> {
		return fileExists(filepath);
	}
}
