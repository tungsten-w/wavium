<?php
// Writes version.php in the format of the official release tarball.
// argv: fork version.php, output path, build string.
require $argv[1];
$e = fn ($v) => var_export($v, true);
file_put_contents($argv[2], "<?php \n"
  . '$OC_Version = ' . $e($OC_Version) . ";\n"
  . '$OC_VersionString = ' . $e($OC_VersionString) . ";\n"
  . "\$OC_Edition = '';\n"
  // "git": Nextcloud skips the code-signature check (our changes are not
  // signed by Nextcloud) and the updater stays quiet.
  . "\$OC_Channel = 'git';\n"
  . '$OC_VersionCanBeUpgradedFrom = ' . $e($OC_VersionCanBeUpgradedFrom) . ";\n"
  . '$OC_Build = ' . $e($argv[3]) . ";\n"
  . '$vendor = ' . $e($vendor) . ";\n");
