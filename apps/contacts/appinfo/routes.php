<?php

/**
 * SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

return [
	'routes' => [
		['name' => 'contacts#direct', 'url' => '/direct/contact/{contact}', 'verb' => 'GET'],
		['name' => 'contacts#directcircle', 'url' => '/direct/circle/{singleId}', 'verb' => 'GET'],
		['name' => 'social_api#update_contact',  'url' => '/api/v1/social/avatar/{network}/{addressbookId}/{contactId}', 'verb' => 'PUT'],
		['name' => 'social_api#set_app_config',	 'url' => '/api/v1/social/config/global/{key}', 'verb' => 'PUT'],
		['name' => 'social_api#set_user_config', 'url' => '/api/v1/social/config/user/{key}', 'verb' => 'PUT'],
		['name' => 'social_api#get_user_config', 'url' => '/api/v1/social/config/user/{key}', 'verb' => 'GET'],
		// Atrium agent layer, internal only (server/agent/contacts/).
		['name' => 'atrium_agent#addressbooks', 'url' => '/api/atrium-agent/addressbooks', 'verb' => 'POST'],
		['name' => 'atrium_agent#list', 'url' => '/api/atrium-agent/list', 'verb' => 'POST'],
		['name' => 'atrium_agent#get', 'url' => '/api/atrium-agent/get', 'verb' => 'POST'],
		['name' => 'atrium_agent#create', 'url' => '/api/atrium-agent/create', 'verb' => 'POST'],
		['name' => 'atrium_agent#update', 'url' => '/api/atrium-agent/update', 'verb' => 'POST'],
		['name' => 'atrium_agent#delete', 'url' => '/api/atrium-agent/delete', 'verb' => 'POST'],
		['name' => 'atrium_agent#restore', 'url' => '/api/atrium-agent/restore', 'verb' => 'POST'],
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
		// Catch-all so any client-side route survives a page reload
		['name' => 'page#index', 'url' => '/{path}', 'verb' => 'GET', 'postfix' => 'path', 'requirements' => ['path' => '.*']],
	]
];
