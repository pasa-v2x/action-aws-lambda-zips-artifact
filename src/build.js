const { execSync } = require("child_process");
const fs = require("fs");
const core = require("@actions/core");

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const buildAndUpload = async function (dir) {
  // call git to get the full path to the directory of the repo
  const repoPath = execSync("git rev-parse --show-toplevel").toString().trim();

  // create full paths for exec commands
  const buildPath = "/tmp/build"
  fs.mkdirSync(buildPath, { recursive: true });
  const lambdaPath = `${repoPath}/${dir}`;

  const LANG = determineLanguage(lambdaPath);

  // get last folder in dir and use as artifactName
  const lambdaBaseName = dir.split("/").pop();
  const lambdaZipPath = `${buildPath}/${lambdaBaseName}.zip`;
  const lambdaLayerZipPath = `${buildPath}/${lambdaBaseName}_layer.zip`;

  // create switch the uses language to build
  switch (LANG) {
    case "golang":
      await buildGolang(lambdaPath, lambdaZipPath);
      break;
    case "python":
      await buildPython(lambdaPath, lambdaZipPath, lambdaLayerZipPath);
      break;
    case "nodejs":
      await buildJavascript(lambdaPath, lambdaZipPath, lambdaLayerZipPath);
      break;
    case "typescript":
      await buildTypescript(lambdaPath, lambdaZipPath, lambdaLayerZipPath);
      break;
    default:
      core.setFailed("Language not supported");
  }
};

const path = require('path');
const glob = require('glob');

function determineLanguage(lambdaPath) {
  if (glob.sync(path.join(lambdaPath, '**/*.go')).length > 0) {
    return 'golang';
  } else if (glob.sync(path.join(lambdaPath, '**/*.py')).length > 0 ) {
    return 'python';
  } else if (glob.sync(path.join(lambdaPath, '**/*.ts')).length > 0 ) {
    return 'typescript';
  } else if (glob.sync(path.join(lambdaPath, '**/*.js')).length > 0 ) {
    return 'nodejs';
  }
}


async function buildGolang(lambdaPath, lambdaZipPath) {
  const command = ` cd ${lambdaPath}
GOOS=linux GOARCH=amd64 go build -tags lambda.norpc -o bootstrap 
zip ${lambdaZipPath} bootstrap
rm bootstrap
`;
  try {
    execSync(command);
    upload(lambdaZipPath)
  } catch (error) {
    core.setFailed(`An error occurred while building Golang: ${error.message}`);
  }
}

async function buildPython(lambdaPath, lambdaZipPath, lambdaLayerZipPath) {
  const zipLambdaCommand = ` cd ${lambdaPath}/src
zip -r ${lambdaZipPath} .
`;
  try {
    execSync(zipLambdaCommand);
    upload(lambdaZipPath);

    let zipLayerCommand;
    if (fs.existsSync(`${lambdaPath}/Pipfile`)) {
      zipLayerCommand = ` cd ${lambdaPath}
pipenv install
PY_VERSION=$(grep -oP 'python_version = "\K[^"]+' Pipfile)
PY_VERSION=$(awk -F'"' '/python_version/ {print $2}' Pipfile)
SITE_PACKAGES=$(pipenv --venv)/lib/python$PY_VERSION/site-packages
cd $SITE_PACKAGES
zip -q -r ${lambdaLayerZipPath} *
`;
    } else if (fs.existsSync(`${lambdaPath}/requirements.txt`)) {
      zipLayerCommand = ` cd ${lambdaPath}
pip install -r requirements.txt -t python
zip -q -r ${lambdaLayerZipPath} python/
rm -Rf python
`;
    }else{
      return
    }
    execSync(zipLayerCommand);
    upload(lambdaLayerZipPath);
  } catch (error) {
    core.setFailed(`An error occurred while building Python: ${error.message}`);
  }
}

async function buildJavascript(
  lambdaPath,
  lambdaZipPath,
  lambdaLayerZipPath
) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(`${lambdaPath}/package.json`));
    let nodeVersion = packageJson.engines?.node?.replace('>=', '') || '18.x';
    
    nodeVersion = nodeVersion.replace('.x', '');
    
    const buildCommand = `
      source $HOME/.nvm/nvm.sh && \
      nvm install ${nodeVersion} && \
      nvm use ${nodeVersion} && \
      cd ${lambdaPath}/src && \
      zip -r ${lambdaZipPath} .
    `;
    execSync(buildCommand, { stdio: 'inherit', shell: '/bin/bash' });
    upload(lambdaZipPath);

    if (fs.existsSync(`${lambdaPath}/package.json`)) {
      const layerCommand = `
        source $HOME/.nvm/nvm.sh && \
        nvm use ${nodeVersion} && \
        cd ${lambdaPath} && \
        npm install --omit=dev
      `;
      execSync(layerCommand, { stdio: 'inherit', shell: '/bin/bash' });

      if (fs.existsSync(`${lambdaPath}/node_modules`)) {
        fs.rmSync(`${lambdaPath}/nodejs`, { recursive: true, force: true });
        fs.mkdirSync(`${lambdaPath}/nodejs`, { recursive: true });
        execSync(`mv ${lambdaPath}/node_modules ${lambdaPath}/nodejs && \
          cd ${lambdaPath} && \
          zip -q -r ${lambdaLayerZipPath} nodejs && \
          rm -Rf nodejs node_modules
        `, { stdio: 'inherit', shell: '/bin/bash' });
        upload(lambdaLayerZipPath);
      }
    }
  } catch (error) {
    core.setFailed(
      `An error occurred while building Javascript: ${error.message}`
    );
  }
}


async function buildTypescript(
  lambdaPath,
  lambdaZipPath,
  lambdaLayerZipPath
) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(`${lambdaPath}/package.json`));
    let nodeVersion = packageJson.engines?.node?.replace('>=', '') || '18.x';
    
    nodeVersion = nodeVersion.replace('.x', '');
    
    const buildCommand = `
      source $HOME/.nvm/nvm.sh && \
      nvm install ${nodeVersion} && \
      nvm use ${nodeVersion} && \
      cd ${lambdaPath} && \
      npm install --include=dev && \
      npm run build || true && \
      cd dist && \
      zip -r ${lambdaZipPath} .
    `;
    execSync(buildCommand, { stdio: 'inherit', shell: '/bin/bash' });
    upload(lambdaZipPath);

    if (fs.existsSync(`${lambdaPath}/package.json`)) {
      const layerCommand = `
        source $HOME/.nvm/nvm.sh && \
        nvm use ${nodeVersion} && \
        cd ${lambdaPath} && \
        npm install --omit=dev
      `;
      execSync(layerCommand, { stdio: 'inherit', shell: '/bin/bash' });

      if (fs.existsSync(`${lambdaPath}/node_modules`)) {
        fs.rmSync(`${lambdaPath}/nodejs`, { recursive: true, force: true });
        fs.mkdirSync(`${lambdaPath}/nodejs`, { recursive: true });
        execSync(`mv ${lambdaPath}/node_modules ${lambdaPath}/nodejs && \
          cd ${lambdaPath} && \
          zip -q -r ${lambdaLayerZipPath} nodejs && \
          rm -Rf nodejs node_modules dist
        `, { stdio: 'inherit', shell: '/bin/bash' });
        upload(lambdaLayerZipPath);
      }
    }
  } catch (error) {
    core.setFailed(
      `An error occurred while building Typescript: ${error.message}`
    );
  }
}

async function upload(artifactPath){
  try {
    const bucket = core.getInput("s3-bucket", { required: true });
    const s3Client = new S3Client();

    // take the artifactPath grab the artifact filename
    const artifactName = artifactPath.split("/").pop();
    
    // call git to get commit hash
    const isShortHash = core.getInput("short-commit-hash", { required: false });
    const commitHash = execSync(`git log -1 --format=format:%${isShortHash ? 'h' : 'H'}`)
      .toString()
      .trim();
    // call git to get the name of the repo
    const repoName = execSync("basename `git rev-parse --show-toplevel`")
      .toString()
      .trim();
    if (fs.existsSync(artifactPath)) {
      const uploadParams = {
        Bucket: bucket,
        Key: `${repoName}/${commitHash}/${artifactName}`,
        Body: fs.createReadStream(artifactPath),
      };

      await s3Client.send(new PutObjectCommand(uploadParams));
      fs.unlinkSync(artifactPath);
    }
  } catch (error) {
    core.setFailed(`An error occurred while uploading to S3: ${error.message}`);
  }
}

module.exports = buildAndUpload;