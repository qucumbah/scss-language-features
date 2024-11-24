/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import { ITsConfig } from '../types/symbols';

export function resolveAliasedPath(fsPath: string, documentPath: string, associatedTsConfig?: ITsConfig) {
	const matchingShorthand = associatedTsConfig?.paths?.find((pathShorthand) =>
		fsPath.startsWith(pathShorthand.alias)
	);

	if (!associatedTsConfig || !matchingShorthand) {
		return path.resolve(path.dirname(documentPath), fsPath);
	}

	const inputFragmentAfterReplacement = fsPath.replace(matchingShorthand.alias, matchingShorthand.paths[0]!);
	return path.resolve(path.dirname(associatedTsConfig.filepath), inputFragmentAfterReplacement);
}
