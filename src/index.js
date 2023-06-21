const build = require("./build")
const upload = require("./upload")
const core = require("@actions/core");

async function run() {
  try {
    const lambdaPaths = parseLambdaPaths();
    
    lambdaPaths.forEach(async (lambdaPath) => {
      const artifactFiles = await build(lambdaPath);
      artifactFiles.forEach(async (artifactFile) => {
        await upload(artifactFile);
      });
    });
    
  } catch (error) {
    core.setFailed(error.message);
  }
}

function parseLambdaPaths() {
  const input = core.getInput("lambda-paths", { required: true })
  const lambdaPaths = [];
  for (const path of input.split(/\r|\n/)) {
    lambdaPaths.push(path.trim());
  }
  return lambdaPaths;
}

run().then(() => {
  console.log("Finished");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
