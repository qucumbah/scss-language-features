/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';

import * as fg from 'fast-glob';

export function findFiles(
	pattern: string,
	options: fg.Options
): Promise<string[]> {
	return fg.glob(pattern, {
		...options,
		absolute: true,
		dot: true,
		suppressErrors: true,
	});
}

export function fileExists(filepath: string): Promise<boolean> {
	return new Promise((resolve) => {
		fs.access(filepath, fs.constants.F_OK, (error) => {
			return resolve(error === null);
		});
	});
}

export function fileExistsSync(filepath: string): boolean {
	return fs.existsSync(filepath);
}

/**
 * Read file by specified filepath;
 */
export function readFile(filepath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		fs.readFile(filepath, (err, data) => {
			if (err) {
				return reject(err);
			}

			resolve(data.toString());
		});
	});
}

/**
 * Get all file names from specified directory;
 */
export function readDir(filepath: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		fs.readdir(filepath, (err, data) => {
			if (err) {
				return reject(err);
			}

			resolve(data);
		});
	});
}

/**
 * Read file by specified filepath;
 */
export function statFile(filepath: string): Promise<fs.Stats> {
	return new Promise((resolve, reject) => {
		fs.stat(filepath, (err, stat) => {
			if (err) {
				return reject(err);
			}

			resolve(stat);
		});
	});
}

/**
 * Checks if file is descendant of directory;
 */
export function isDescendant(file: string, dir: string): boolean {
	const relative = path.relative(dir, file);
	return Boolean(
		relative && !relative.startsWith('..') && !path.isAbsolute(relative)
	);
}

/**
 * Checks if file exists in directory or in its parents up until the limit directory;
 */
export async function findFileInParents(
	filename: string,
	dir: string,
	limit: string
): Promise<string | undefined> {
	if (!isDescendant(dir, limit) || isDescendant(limit, dir)) {
		return;
	}

	while (dir !== limit) {
		const filepath = path.join(dir, filename);
		if (await fileExists(filepath)) {
			return filepath;
		}

		dir = path.dirname(dir);
	}

	return;
}

/**
 * Make URI a normalized absolute FS path;
 */
export function uriToFsPath(uri: string) {
	return path.normalize(uri.startsWith('file://') ? URI.parse(uri).fsPath : uri);
}
/**
 * Make FS path a normalized absolute URI;
 */
export function fsPathToUri(pathname: string) {
	return URI.file(path.normalize(pathname)).toString();
}
