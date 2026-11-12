<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OC\Core\Command\Agent;

use OCP\Agent\IAgentManager;
use OCP\IUserManager;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * Atrium (ADR 0009): turn an existing account into an agent owned by someone
 * (e.g. `occ agent:adopt nova --owner alice`). New agents are created in
 * Settings > Agents instead.
 */
class Adopt extends Command {
	public function __construct(
		private IUserManager $userManager,
		private IAgentManager $agentManager,
	) {
		parent::__construct();
	}

	#[\Override]
	protected function configure(): void {
		$this->setName('agent:adopt')
			->setDescription('Atrium: register an existing account as an agent of an owner')
			->addArgument('uid', InputArgument::REQUIRED, 'The account that becomes an agent')
			->addOption('owner', null, InputOption::VALUE_REQUIRED, 'The user who owns and configures the agent')
			->addOption('description', null, InputOption::VALUE_REQUIRED, 'What the agent is for', '');
	}

	#[\Override]
	protected function execute(InputInterface $input, OutputInterface $output): int {
		$uid = (string)$input->getArgument('uid');
		$owner = (string)$input->getOption('owner');
		if ($owner === '') {
			$output->writeln('<error>--owner is required</error>');
			return self::FAILURE;
		}
		try {
			$this->agentManager->registerAgent($uid, $owner, (string)$input->getOption('description'));
		} catch (\InvalidArgumentException $e) {
			$output->writeln('<error>' . $e->getMessage() . '</error>');
			return self::FAILURE;
		}
		$output->writeln("$uid is now an agent of $owner. Web login is off for it; create a token in Settings > Agents.");
		return self::SUCCESS;
	}
}
