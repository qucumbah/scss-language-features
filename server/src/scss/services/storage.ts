/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IDocumentSymbols, ITsConfig } from '../types/symbols';

export type Storage = Map<StorageItemKey, StorageItemValue>;
export type StorageItemEntry = [StorageItemKey, StorageItemValue];
export type StorageItemKey = string;
export type StorageItemValue = IDocumentSymbols;

export default class StorageService {
	private readonly _scssDocuments: Storage = new Map();
	private readonly _tsConfigs: Map<StorageItemKey, ITsConfig> = new Map();
	// Associations between scss path and tsconfig path
	private readonly _tsConfigsAssociations: Map<StorageItemKey, StorageItemKey> =
		new Map();

	public get(key: StorageItemKey): StorageItemValue | undefined {
		return this._scssDocuments.get(key);
	}

	public set(key: StorageItemKey, value: StorageItemValue): void {
		this._scssDocuments.set(key, value);
	}

	public delete(key: string): void {
		this._scssDocuments.delete(key);
	}

	public clear(): void {
		this._scssDocuments.clear();
		this._tsConfigs.clear();
	}

	public getTsConfig(configUri: StorageItemKey) {
		return this._tsConfigs.get(configUri);
	}

	public setTsConfig(configUri: StorageItemKey, configValue: ITsConfig) {
		this._tsConfigs.set(configUri, configValue);
	}

	public deleteTsConfig(configUri: StorageItemKey) {
		this._tsConfigs.delete(configUri);
	}

	public getAssociatedTsConfig(scssUri: StorageItemKey) {
		const associatedTsConfigUri = this._tsConfigsAssociations.get(scssUri);
		return associatedTsConfigUri
			? this._tsConfigs.get(associatedTsConfigUri)
			: undefined;
	}

	public associate(scssUri: StorageItemKey, tsConfigUri: string) {
		this._tsConfigsAssociations.set(scssUri, tsConfigUri);
	}

	public desociate(scssUri: StorageItemKey) {
		this._tsConfigsAssociations.delete(scssUri);
	}

	public keys(): StorageItemKey[] {
		return [...this._scssDocuments.keys()];
	}

	public values(): StorageItemValue[] {
		return [...this._scssDocuments.values()];
	}

	public entries(): StorageItemEntry[] {
		return [...this._scssDocuments.entries()];
	}
}
