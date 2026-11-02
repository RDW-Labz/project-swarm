// SPDX-License-Identifier: Apache-2.0
// Files whose deletion (or change) the owner must review: dependency manifests and lockfiles, CI workflows and actions, the profile, ownership and
// ignore files, package manager settings, hooks. One list for the security gate and for ticket validation.
const NAMES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|poetry\.lock|pyproject\.toml|Pipfile(?:\.lock)?|Cargo\.(?:toml|lock)|go\.(?:mod|sum|work)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|requirements[^/]*\.txt|CODEOWNERS|dependabot\.ya?ml|\.gitignore|\.gitattributes|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|\.gitleaks\.toml|\.semgrepignore|\.project-swarm\.json)$/i;
const DIRS = /(^|\/)(\.github\/(?:workflows|actions)|\.husky|\.gitlab-ci\.yml|\.circleci)(\/|$)/i;

export const isSensitivePath = file => {
  const f = String(file ?? '').split('\\').join('/').replace(/^\.\//, '');
  return NAMES.test(f) || DIRS.test(f);
};
