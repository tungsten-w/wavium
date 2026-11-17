<?php

declare(strict_types=1);
// SPDX-FileCopyrightText: 2026 Wavium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace OCA\Messages\Controller;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\RedirectResponse;

/**
 * The page is the React app, served by Wavium's shell (core/web) on
 * /apps/messages/. This route only gives the app its navigation entry; a
 * request that reaches PHP (no shell) goes to the shell's address.
 */
class PageController extends Controller {
	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): RedirectResponse {
		return new RedirectResponse('/apps/messages/');
	}
}
