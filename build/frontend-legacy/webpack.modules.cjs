/**
 * SPDX-FileCopyrightText: 2021 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// Atrium: no central list. Each app declares its entries in apps/<id>/web/legacy.json.
const { legacyEntries } = require('../atrium/legacy-entries.cjs')

module.exports = legacyEntries('webpack', __dirname)
