/**
 * pnpm hook to ensure @electron/node-gyp always uses HTTPS tarball instead of git SSH
 * This prevents authentication issues in CI/build environments
 */
function readPackage(pkg, context) {
  // Force @electron/node-gyp to use HTTPS tarball URL
  if (pkg.dependencies && pkg.dependencies['@electron/node-gyp']) {
    if (pkg.dependencies['@electron/node-gyp'].includes('git@github.com') || 
        pkg.dependencies['@electron/node-gyp'].includes('git+ssh://')) {
      pkg.dependencies['@electron/node-gyp'] = 'https://codeload.github.com/electron/node-gyp/tar.gz/06b29aafb7708acef8b3669835c8a7857ebc92d2';
      context.log(`Rewritten @electron/node-gyp dependency in ${pkg.name} to use HTTPS tarball`);
    }
  }
  
  if (pkg.devDependencies && pkg.devDependencies['@electron/node-gyp']) {
    if (pkg.devDependencies['@electron/node-gyp'].includes('git@github.com') || 
        pkg.devDependencies['@electron/node-gyp'].includes('git+ssh://')) {
      pkg.devDependencies['@electron/node-gyp'] = 'https://codeload.github.com/electron/node-gyp/tar.gz/06b29aafb7708acef8b3669835c8a7857ebc92d2';
      context.log(`Rewritten @electron/node-gyp devDependency in ${pkg.name} to use HTTPS tarball`);
    }
  }
  
  return pkg;
}

module.exports = {
  hooks: {
    readPackage
  }
};
