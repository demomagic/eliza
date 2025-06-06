import { buildProject, handleError, runBunCommand } from '@/src/utils';
import { displayBanner } from '@/src/utils';
import { Command } from 'commander';
import { execa } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';
import * as semver from 'semver';
import {
  isGlobalInstallation,
  isRunningViaNpx,
  isRunningViaBunx,
  executeInstallation,
} from '@/src/utils';
import { logger } from '@elizaos/core';
import {
  detectDirectoryType,
  getDirectoryTypeDescription,
  isValidForUpdates,
  type DirectoryInfo,
} from '../utils/directory-detection';

// Function to get the package version
function getVersion(): string {
  // For ESM modules we need to use import.meta.url instead of __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Find package.json relative to the current file
  const packageJsonPath = path.resolve(__dirname, '../package.json');

  // Add a simple check in case the path is incorrect
  let version = '0.0.0'; // Fallback version
  if (!existsSync(packageJsonPath)) {
    console.warn(`Warning: package.json not found at ${packageJsonPath}`);
  } else {
    try {
      const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(packageJsonContent);
      version = packageJson.version || '0.0.0';
    } catch (error) {
      console.error(`Error reading or parsing package.json at ${packageJsonPath}:`, error);
    }
  }
  return version;
}

/**
 * Check if a package is using a workspace reference
 * @param versionString The version string to check
 * @returns Whether the version string indicates a workspace reference
 */
function isWorkspaceVersion(versionString: string): boolean {
  return (
    versionString === 'workspace:*' ||
    versionString === 'workspace' ||
    versionString.startsWith('workspace:')
  );
}

/**
 * Check if a package version is a special tag
 * @param version The version string to check
 * @returns Whether the version is a special tag
 */
function isSpecialVersionTag(version: string): boolean {
  const specialTags = ['latest', 'next', 'canary', 'rc', 'dev', 'nightly', 'alpha'];
  return specialTags.includes(version);
}

/**
 * Check if a package version needs updating
 * @param currentVersion Current package version
 * @param targetVersion Target version to update to
 * @returns Object with needsUpdate flag and optional error message
 */
function checkVersionNeedsUpdate(
  currentVersion: string,
  targetVersion: string
): { needsUpdate: boolean; error?: string } {
  try {
    // Remove version qualifiers
    const cleanCurrent = String(currentVersion).replace(/^\^|~/, '');

    // Handle special tags
    if (isSpecialVersionTag(cleanCurrent)) {
      return { needsUpdate: true };
    }

    // Skip comparison if not a valid semver string
    if (!semver.valid(cleanCurrent) && !semver.validRange(cleanCurrent)) {
      return { needsUpdate: false, error: 'Cannot determine if update needed - invalid semver' };
    }

    // Get the minimum version if cleanCurrent is a range
    let versionToCompare = cleanCurrent;
    if (semver.validRange(cleanCurrent) && !semver.valid(cleanCurrent)) {
      const minVer = semver.minVersion(cleanCurrent);
      if (!minVer) {
        return { needsUpdate: false, error: 'Could not determine minimum version from range' };
      }
      versionToCompare = minVer.version;
    }

    // Compare versions
    return { needsUpdate: semver.lt(versionToCompare, targetVersion) };
  } catch (error) {
    return { needsUpdate: false, error: `Version comparison error: ${error.message}` };
  }
}

/**
 * Check if updating would result in a major version jump
 * @param currentVersion Current package version
 * @param targetVersion Target version to update to
 * @returns Whether update would cross major versions
 */
function isMajorUpdate(currentVersion: string, targetVersion: string): boolean {
  try {
    const cleanCurrent = String(currentVersion).replace(/^\^|~/, '');

    // Skip comparison for special cases
    if (
      isSpecialVersionTag(cleanCurrent) ||
      (!semver.valid(cleanCurrent) && !semver.validRange(cleanCurrent))
    ) {
      return false;
    }

    // Validate targetVersion
    if (!semver.valid(targetVersion)) {
      return false;
    }
    return semver.major(targetVersion) > semver.major(cleanCurrent);
  } catch {
    return false; // Assume not major on error
  }
}

/**
 * Updates dependencies in a project or plugin to the latest ElizaOS versions
 * @param cwd Working directory of the project/plugin
 * @param isPlugin Whether this is a plugin or project
 * @param dryRun Only check for updates without applying them
 * @param skipBuild Skip building the project after updates
 */
async function updateDependencies(
  cwd: string,
  isPlugin: boolean,
  dryRun: boolean = false,
  skipBuild: boolean = false
): Promise<void> {
  console.info(
    `${dryRun ? 'Checking' : 'Updating'} ${isPlugin ? 'plugin' : 'project'} dependencies...`
  );

  // Get the current CLI version (for informational purposes)
  const currentCliVersion = getVersion();
  // Don't log current CLI version since it's already shown in banner

  try {
    // Find the latest published version by timestamp
    const { stdout } = await execa('npm', ['view', '@elizaos/cli', 'time', '--json']);
    const timeData = JSON.parse(stdout);

    // Remove metadata entries like 'created' and 'modified'
    delete timeData.created;
    delete timeData.modified;

    // Find the most recently published version
    let latestCliVersion = '';
    let latestDate = new Date(0); // Start with epoch time

    for (const [version, dateString] of Object.entries(timeData)) {
      const publishDate = new Date(dateString as string);
      if (publishDate > latestDate) {
        latestDate = publishDate;
        latestCliVersion = version;
      }
    }

    // If we can't find the latest version, use the current version
    if (!latestCliVersion) {
      latestCliVersion = currentCliVersion;
      console.info(
        `Could not determine latest version, using current CLI version: ${latestCliVersion}`
      );
    }
    // Only show latest version if it's different from current
    else if (latestCliVersion !== currentCliVersion) {
      console.info(`Latest available CLI version: ${latestCliVersion}`);
    }

    // Get list of installed dependencies
    const packageJsonPath = path.join(cwd, 'package.json');
    if (!existsSync(packageJsonPath)) {
      console.error('package.json not found in the current directory');
      return;
    }

    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    const dependencies = packageJson.dependencies || {};
    const devDependencies = packageJson.devDependencies || {};

    // Find all ElizaOS packages
    const elizaPackages = [...Object.entries(dependencies), ...Object.entries(devDependencies)]
      .filter(([pkg]) => pkg.startsWith('@elizaos/'))
      .map(([pkg, version]) => ({ name: pkg, version }));

    if (elizaPackages.length === 0) {
      console.info('No ElizaOS packages found to update');
      return;
    }

    // Check for workspace references
    const workspacePackages = elizaPackages.filter((pkg) =>
      isWorkspaceVersion(pkg.version as string)
    );
    if (workspacePackages.length > 0) {
      console.info(
        `Found ${workspacePackages.length} workspace references: ${workspacePackages.map((p) => p.name).join(', ')}`
      );
      console.info(
        'Skipping update for workspace packages as they should be managed by the monorepo'
      );

      // Remove workspace packages from the update list
      const packagesToUpdate = elizaPackages.filter(
        (pkg) => !isWorkspaceVersion(pkg.version as string)
      );
      if (packagesToUpdate.length === 0) {
        console.info('No non-workspace ElizaOS packages to update');
        return;
      }

      console.info(
        `Will ${dryRun ? 'check' : 'update'} ${packagesToUpdate.length} non-workspace packages: ${packagesToUpdate.map((p) => p.name).join(', ')}`
      );

      // Update the list to only include non-workspace packages
      elizaPackages.length = 0;
      elizaPackages.push(...packagesToUpdate);
    }
    // Only show package list if there are many packages or in debug mode
    else if (elizaPackages.length > 5) {
      console.info(
        `Found ${elizaPackages.length} ElizaOS packages: ${elizaPackages.map((p) => p.name).join(', ')}`
      );
    }

    // Use latest tag for stable v1.0.0 release
    const packageTag = 'latest';

    // Display outdated packages
    console.info(`\nElizaOS packages that can be updated to @${packageTag}:`);
    let outdatedPackagesFound = false;

    for (const pkg of elizaPackages) {
      const pkgVersion = String(pkg.version).replace(/^\^|~/, '');
      const versionCheck = checkVersionNeedsUpdate(pkgVersion, latestCliVersion);

      if (versionCheck.error) {
        console.info(`  - ${pkg.name} (${pkgVersion}) → ${versionCheck.error}`);
        continue;
      }

      if (versionCheck.needsUpdate) {
        console.info(`  - ${pkg.name} (${pkgVersion}) → @${packageTag}`);
        outdatedPackagesFound = true;
      }
    }

    if (!outdatedPackagesFound) {
      console.info('All ElizaOS packages are up to date!');
      return;
    }

    if (dryRun) {
      console.info('\nTo update these packages, run the command without the --check flag');
      return;
    }

    // Determine update type - minor by default, major requires confirmation
    const hasMajorUpdates = elizaPackages.some((pkg) =>
      isMajorUpdate(String(pkg.version), latestCliVersion)
    );

    if (hasMajorUpdates) {
      const { confirmMajor } = await prompts({
        type: 'confirm',
        name: 'confirmMajor',
        message: 'Major version updates detected. This may include breaking changes. Continue?',
        initial: false,
      });

      if (!confirmMajor) {
        console.info('Update canceled');
        return;
      }
    }

    // Update only the ones that actually need it
    const packagesNeedingUpdate = elizaPackages.filter(
      (pkg) => checkVersionNeedsUpdate(String(pkg.version), latestCliVersion).needsUpdate
    );

    if (packagesNeedingUpdate.length === 0) {
      console.info('No packages need updates.');
      return;
    }

    // Don't show number of packages being updated - the bun output shows this
    // console.info(`Updating ${packagesNeedingUpdate.length} package(s)...`);

    // Update each package using the appropriate tag instead of specific version
    for (const pkg of packagesNeedingUpdate) {
      try {
        // Don't log each individual update - bun output shows this
        await runBunCommand(['add', `${pkg.name}@${packageTag}`], cwd);
      } catch (error) {
        console.error(`Failed to update ${pkg.name}@${packageTag}: ${error.message}`);
      }
    }

    console.log('Dependencies updated successfully');

    // Run install to ensure all dependencies are properly installed
    // Don't announce installing - bun output shows this
    await runBunCommand(['install'], cwd);

    // Build the project/plugin with updated dependencies
    if (!skipBuild) {
      // Don't announce building - build output shows this
      await buildProject(cwd, isPlugin);
      // Don't announce build completion - build output shows this
    } else {
      console.info('Skipping build phase as requested with --skip-build flag');
    }
  } catch (error) {
    console.error(`Error updating dependencies: ${error.message}`);
    throw error; // Rethrow the error to be handled by the caller
  }
}

/**
 * Updates the CLI to the latest version based on the most recently published version
 * @returns {Promise<boolean>} Whether the update was successful
 */
export async function performCliUpdate(): Promise<boolean> {
  try {
    // get the current version
    const currentVersion = getVersion();

    // Get the time data for all published versions to find the most recent
    const { stdout } = await execa('npm', ['view', '@elizaos/cli', 'time', '--json']);
    const timeData = JSON.parse(stdout);

    // Remove metadata entries like 'created' and 'modified'
    delete timeData.created;
    delete timeData.modified;

    // Find the most recently published version
    let latestVersion = '';
    let latestDate = new Date(0); // Start with epoch time

    for (const [version, dateString] of Object.entries(timeData)) {
      const publishDate = new Date(dateString as string);
      if (publishDate > latestDate) {
        latestDate = publishDate;
        latestVersion = version;
      }
    }

    // If we couldn't determine the latest version or already at latest, exit
    if (!latestVersion || currentVersion === latestVersion) {
      console.info('ElizaOS CLI is already up to date!');
      return true;
    }

    console.info(`Updating ElizaOS CLI from ${currentVersion} to ${latestVersion}...`);

    // Install the specified version globally - use specific version instead of tag
    logger.debug(`Updating Eliza CLI to version: ${latestVersion}`);
    try {
      // Try to install latest version
      const { stdout, stderr } = await execa('npm', ['install', '-g', '@elizaos/cli']);
      logger.info(`Successfully updated Eliza CLI to latest version`);
      logger.info('Please restart your terminal for the changes to take effect.');
    } catch (npmError) {
      // If latest tag fails, try with specific version
      try {
        logger.info(`Latest installation failed, trying specific version: ${latestVersion}`);
        const { stdout, stderr } = await execa('npm', [
          'install',
          '-g',
          `@elizaos/cli@${latestVersion}`,
        ]);
        logger.info(`Successfully updated Eliza CLI to version ${latestVersion}`);
        logger.info('Please restart your terminal for the changes to take effect.');
      } catch (versionError) {
        throw new Error(
          `Installation of @elizaos/cli version ${latestVersion} failed. Try manually with: npm install -g @elizaos/cli`
        );
      }
    }

    console.info('ElizaOS CLI has been successfully updated!');
    return true;
  } catch (error) {
    console.error('Failed to update ElizaOS CLI:', error);
    return false;
  }
}

// Create command for updating dependencies
export const update = new Command()
  .name('update')
  .description('Update ElizaOS CLI and project dependencies')
  .option('-c, --check', 'Check for available updates without applying them')
  .option('-sb, --skip-build', 'Skip building after updating')
  .option('--cli', 'Update only the global CLI installation (without updating packages)')
  .option('--packages', 'Update only packages (without updating the CLI)')
  .hook('preAction', async () => {
    try {
      await displayBanner();
    } catch (error) {
      // Silently continue if banner display fails
      logger.debug('Banner display failed, continuing with update');
    }
  })
  .action(async (options) => {
    try {
      // Flag combinations define behavior:
      // --cli: Update only the CLI
      // --packages: Update only packages
      // Neither flag: Update both CLI and packages
      // Both flags: Update both CLI and packages

      let updateCli = false;
      let updatePackages = false;

      if (!options.cli && !options.packages) {
        updateCli = true;
        updatePackages = true;
      } else {
        updateCli = !!options.cli;
        updatePackages = !!options.packages;
      }
      // Handle CLI update if requested
      if (updateCli) {
        // Check if we're running via npx/bunx
        if ((await isRunningViaNpx()) || (await isRunningViaBunx())) {
          console.warn('CLI update is not available when running via npx or bunx.');
          console.info('To install the latest version, run: npm install -g @elizaos/cli');
        }
        // Check if globally installed
        else if (!(await isGlobalInstallation())) {
          console.warn('The CLI update is only available for globally installed CLI.');
          console.info('To update a local installation, use your package manager manually.');
          console.info('For global installation, run: npm install -g @elizaos/cli');
        }
        // Run CLI update
        else {
          console.info('Checking for ElizaOS CLI updates...');
          try {
            const cliUpdated = await performCliUpdate();
            if (!updatePackages && cliUpdated) {
              return; // Exit if only CLI update was requested and it succeeded
            }
          } catch (error) {
            if (!updatePackages) {
              handleError(error);
              return; // Exit if only CLI update was requested and it failed
            }
            // Otherwise continue with package updates
            console.warn('CLI update failed, continuing with package updates...');
          }
        }
      }

      // Handle package updates if requested
      if (updatePackages) {
        const cwd = process.cwd();

        // Detect directory type using comprehensive detection
        const directoryInfo = detectDirectoryType(cwd);
        const directoryDescription = getDirectoryTypeDescription(directoryInfo);

        // Only show directory detection in debug mode
        logger.debug(`Detected ${directoryDescription}`);

        // Check if this directory is suitable for updates
        if (!isValidForUpdates(directoryInfo)) {
          switch (directoryInfo.type) {
            case 'empty':
              console.info('This appears to be an empty directory.');
              console.info('To create a new ElizaOS project or plugin, use:');
              console.info(
                '  elizaos create <project-name>                    # Create a new project'
              );
              console.info(
                '  elizaos create -t plugin <plugin-name>          # Create a new plugin'
              );
              return;

            case 'non-elizaos-project':
              console.info(
                "This directory contains a project, but it doesn't appear to be an ElizaOS project."
              );
              if (directoryInfo.packageName) {
                console.info(`Found package: ${directoryInfo.packageName}`);
              }
              console.info('ElizaOS update only works in ElizaOS projects and plugins.');
              console.info('To create a new ElizaOS project, use: elizaos create <project-name>');
              return;

            case 'invalid':
              console.error('Cannot update packages in this directory.');
              if (!directoryInfo.hasPackageJson) {
                console.info(
                  "No package.json found. This doesn't appear to be a valid project directory."
                );
                console.info('To create a new ElizaOS project, use: elizaos create <project-name>');
              } else {
                console.info('The package.json file appears to be invalid or unreadable.');
              }
              return;

            default:
              console.error(`Unexpected directory type: ${directoryInfo.type}`);
              return;
          }
        }

        // If we get here, it's a valid ElizaOS project or plugin
        const isPlugin = directoryInfo.type === 'elizaos-plugin';

        if (directoryInfo.elizaPackageCount === 0) {
          console.info('No ElizaOS packages found in this project.');
          console.info(
            "This might be a new project that hasn't installed ElizaOS dependencies yet."
          );
          console.info('Consider adding ElizaOS packages first, such as: bun add @elizaos/core');
          return;
        }

        console.info(
          `Found ${directoryInfo.elizaPackageCount} ElizaOS package(s) to check for updates`
        );

        // Always call updateDependencies, passing the check flag to determine if it's a dry run
        await updateDependencies(cwd, isPlugin, options.check || false, options.skipBuild || false);

        if (options.check) {
          // When checking, output current version
          const version = getVersion();
          console.log(`Version: ${version}`);
        } else {
          console.log(
            `${isPlugin ? 'Plugin' : 'Project'} successfully updated to the latest ElizaOS packages`
          );
        }
      }
    } catch (error) {
      handleError(error);
    }
  });
