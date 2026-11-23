<?php

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare(strict_types=1);

namespace Test\Theming;

use OCA\Theming\Controller\UserThemeController;
use OCA\Theming\Service\BackgroundService;
use OCA\Theming\Service\ThemesService;
use OCA\Theming\ThemingDefaults;
use OCP\Config\IUserConfig;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserSession;
use Test\TestCase;

/**
 * Choosing an accent colour and then a wallpaper used to answer 500.
 *
 * Atrium's BeforePreferenceListener bumps theming/userCacheBuster when the
 * accent colour changes, and writes it with setValueString. A stored value type
 * cannot change afterwards, so the next wallpaper change -- which wrote the same
 * key through IConfig::setUserValue, i.e. type "mixed" -- threw
 * TypeConflictException and the request failed with 500.
 *
 * The controller must therefore write that key the same way the listener does.
 */
class UserThemeCacheBusterTest extends TestCase {
	private IConfig $config;
	private IUserConfig $userConfig;
	private BackgroundService $backgroundService;
	private UserThemeController $controller;

	protected function setUp(): void {
		parent::setUp();
		$user = $this->createMock(IUser::class);
		$user->method('getUID')->willReturn('alice');
		$session = $this->createMock(IUserSession::class);
		$session->method('getUser')->willReturn($user);

		$this->config = $this->createMock(IConfig::class);
		// The value the listener left behind: version 3, stored as a string.
		$this->config->method('getUserValue')->willReturn('3');
		$this->userConfig = $this->createMock(IUserConfig::class);
		$this->backgroundService = $this->createMock(BackgroundService::class);

		$defaults = $this->createMock(ThemingDefaults::class);
		$defaults->method('getColorBackground')->willReturn('#ffffff');
		$defaults->method('getColorPrimary')->willReturn('#00679e');

		$this->controller = new UserThemeController(
			'theming',
			$this->createMock(IRequest::class),
			$this->config,
			$this->userConfig,
			$session,
			$this->createMock(ThemesService::class),
			$defaults,
			$this->backgroundService,
		);
	}

	public function testCacheBusterIsWrittenAsAStringNotMixed(): void {
		$this->userConfig->expects($this->once())
			->method('setValueString')
			->with('alice', 'theming', 'userCacheBuster', '4');
		// The legacy setter is what used to throw: it must not be used for this key.
		$this->config->expects($this->never())->method('setUserValue');
		$this->backgroundService->expects($this->once())->method('setDefaultBackground');

		$response = $this->controller->setBackground(BackgroundService::BACKGROUND_DEFAULT);

		$this->assertSame(200, $response->getStatus());
		$this->assertSame(4, $response->getData()['version']);
	}

	public function testPickingAShippedWallpaperAlsoBumpsTheSameWay(): void {
		$this->userConfig->expects($this->once())
			->method('setValueString')
			->with('alice', 'theming', 'userCacheBuster', '4');
		$this->config->expects($this->never())->method('setUserValue');
		$this->backgroundService->expects($this->once())
			->method('setShippedBackground')
			->with('tommy-chau-already.jpg');

		$response = $this->controller->setBackground(BackgroundService::BACKGROUND_SHIPPED, 'tommy-chau-already.jpg');

		$this->assertSame(200, $response->getStatus());
	}
}
