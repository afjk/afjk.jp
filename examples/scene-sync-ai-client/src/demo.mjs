import { SceneSyncClient } from './scene-sync-client.mjs';

const client = new SceneSyncClient();
const [, , command, ...rest] = process.argv;

function printUsage() {
  console.log(`Usage:
  npm run demo -- redeem <code>
  npm run demo -- scene <roomId> <sessionId>
  npm run demo -- add-cube <roomId> <sessionId> [objectId]
  npm run demo -- focus <roomId> <sessionId> <objectId>
  npm run demo -- screenshot <roomId> <sessionId>
  npm run demo -- revoke <sessionId>
`);
}

async function main() {
  switch (command) {
    case 'redeem': {
      const [code] = rest;
      console.log(JSON.stringify(await client.redeem(code), null, 2));
      return;
    }
    case 'scene': {
      const [roomId, sessionId] = rest;
      console.log(JSON.stringify(await client.getScene(roomId, sessionId), null, 2));
      return;
    }
    case 'add-cube': {
      const [roomId, sessionId, objectId = 'demo-cube-1'] = rest;
      console.log(JSON.stringify(await client.broadcast(roomId, sessionId, {
        kind: 'scene-add',
        objectId,
        name: 'Demo Cube',
        position: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: {
          type: 'primitive',
          primitive: 'box',
          color: '#ff8800',
        },
      }), null, 2));
      return;
    }
    case 'focus': {
      const [roomId, sessionId, objectId] = rest;
      console.log(JSON.stringify(await client.aiCommand(roomId, sessionId, 'focusObject', {
        objectId,
      }), null, 2));
      return;
    }
    case 'screenshot': {
      const [roomId, sessionId] = rest;
      console.log(JSON.stringify(await client.aiCommand(roomId, sessionId, 'screenshot', {}), null, 2));
      return;
    }
    case 'revoke': {
      const [sessionId] = rest;
      console.log(JSON.stringify(await client.revoke(sessionId), null, 2));
      return;
    }
    default:
      printUsage();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
