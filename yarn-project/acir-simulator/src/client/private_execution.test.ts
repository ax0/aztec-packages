import {
  CallContext,
  CircuitsWasm,
  ContractDeploymentData,
  FunctionData,
  L1_TO_L2_MESSAGES_TREE_HEIGHT,
  NEW_COMMITMENTS_LENGTH,
  PRIVATE_DATA_TREE_HEIGHT,
  PrivateHistoricTreeRoots,
  PublicCallRequest,
  TxContext,
} from '@aztec/circuits.js';
import { computeSecretMessageHash, siloCommitment } from '@aztec/circuits.js/abis';
import { Grumpkin, pedersenPlookupCommitInputs } from '@aztec/circuits.js/barretenberg';
import { FunctionAbi } from '@aztec/foundation/abi';
import { AztecAddress } from '@aztec/foundation/aztec-address';
import { toBufferBE } from '@aztec/foundation/bigint-buffer';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Fr } from '@aztec/foundation/fields';
import { DebugLogger, createDebugLogger } from '@aztec/foundation/log';
import { AppendOnlyTree, Pedersen, StandardTree, newTree } from '@aztec/merkle-tree';
import {
  ChildAbi,
  NonNativeTokenContractAbi,
  ParentAbi,
  TestContractAbi,
  ZkTokenContractAbi,
} from '@aztec/noir-contracts/examples';
import { PackedArguments, TxExecutionRequest } from '@aztec/types';
import { mock } from 'jest-mock-extended';
import { default as levelup } from 'levelup';
import { default as memdown, type MemDown } from 'memdown';
import { encodeArguments } from '../abi_coder/index.js';
import { buildL1ToL2Message } from '../test/utils.js';
import { NoirPoint, computeSlotForMapping, toPublicKey } from '../utils.js';
import { DBOracle } from './db_oracle.js';
import { AcirSimulator } from './simulator.js';

const createMemDown = () => (memdown as any)() as MemDown<any, any>;

describe('Private Execution test suite', () => {
  let circuitsWasm: CircuitsWasm;
  let oracle: ReturnType<typeof mock<DBOracle>>;
  let acirSimulator: AcirSimulator;
  let historicRoots = PrivateHistoricTreeRoots.empty();
  let logger: DebugLogger;

  const treeHeights: { [name: string]: number } = {
    privateData: PRIVATE_DATA_TREE_HEIGHT,
    l1ToL2Messages: L1_TO_L2_MESSAGES_TREE_HEIGHT,
  };
  const trees: { [name: keyof typeof treeHeights]: AppendOnlyTree } = {};
  const txContext = new TxContext(false, false, false, ContractDeploymentData.empty(), new Fr(69), new Fr(420));

  const runSimulator = async ({
    abi,
    args = [],
    origin = AztecAddress.random(),
    contractAddress = AztecAddress.random(),
    isConstructor = false,
  }: {
    abi: FunctionAbi;
    origin?: AztecAddress;
    contractAddress?: AztecAddress;
    isConstructor?: boolean;
    args?: any[];
  }) => {
    const packedArguments = await PackedArguments.fromArgs(encodeArguments(abi, args), circuitsWasm);
    const txRequest = TxExecutionRequest.from({
      origin,
      argsHash: packedArguments.hash,
      functionData: new FunctionData(Buffer.alloc(4), true, isConstructor),
      txContext,
      packedArguments: [packedArguments],
    });

    return acirSimulator.run(
      txRequest,
      abi,
      isConstructor ? AztecAddress.ZERO : contractAddress,
      EthAddress.ZERO,
      historicRoots,
    );
  };

  const insertLeaves = async (leaves: Buffer[], name = 'privateData') => {
    if (!treeHeights[name]) {
      throw new Error(`Unknown tree ${name}`);
    }
    if (!trees[name]) {
      const db = levelup(createMemDown());
      const pedersen = new Pedersen(circuitsWasm);
      trees[name] = await newTree(StandardTree, db, pedersen, name, treeHeights[name]);
    }
    await trees[name].appendLeaves(leaves);

    // Update root.
    const newRoot = trees[name].getRoot(false);
    const prevRoots = historicRoots.toBuffer();
    const rootIndex = name === 'privateData' ? 0 : 32 * 3;
    const newRoots = Buffer.concat([prevRoots.slice(0, rootIndex), newRoot, prevRoots.slice(rootIndex + 32)]);
    historicRoots = PrivateHistoricTreeRoots.fromBuffer(newRoots);

    return trees[name];
  };

  const hash = (data: Buffer[]) => pedersenPlookupCommitInputs(circuitsWasm, data);

  beforeAll(async () => {
    circuitsWasm = await CircuitsWasm.get();
    logger = createDebugLogger('aztec:test:private_execution');
  });

  beforeEach(() => {
    oracle = mock<DBOracle>();
    acirSimulator = new AcirSimulator(oracle);
  });

  describe('empty constructor', () => {
    it('should run the empty constructor', async () => {
      const abi = TestContractAbi.functions[0];
      const result = await runSimulator({ abi, isConstructor: true });
      expect(result.callStackItem.publicInputs.newCommitments).toEqual(new Array(NEW_COMMITMENTS_LENGTH).fill(Fr.ZERO));
    });
  });

  describe('zk token contract', () => {
    let currentNonce = 0n;

    let ownerPk: Buffer;
    let owner: NoirPoint;
    let recipientPk: Buffer;
    let recipient: NoirPoint;

    const buildNote = (amount: bigint, owner: NoirPoint) => {
      return [new Fr(amount), new Fr(owner.x), new Fr(owner.y), Fr.random(), new Fr(currentNonce++), new Fr(1n)];
    };

    beforeAll(() => {
      ownerPk = Buffer.from('5e30a2f886b4b6a11aea03bf4910fbd5b24e61aa27ea4d05c393b3ab592a8d33', 'hex');
      recipientPk = Buffer.from('0c9ed344548e8f9ba8aa3c9f8651eaa2853130f6c1e9c050ccf198f7ea18a7ec', 'hex');

      const grumpkin = new Grumpkin(circuitsWasm);
      owner = toPublicKey(ownerPk, grumpkin);
      recipient = toPublicKey(recipientPk, grumpkin);
    });

    it('should a constructor with arguments that creates notes', async () => {
      const abi = ZkTokenContractAbi.functions.find(f => f.name === 'constructor')!;

      const result = await runSimulator({ args: [140, owner], abi, isConstructor: true });

      expect(result.preimages.newNotes).toHaveLength(1);
      const newNote = result.preimages.newNotes[0];
      expect(newNote.storageSlot).toEqual(computeSlotForMapping(new Fr(1n), owner, circuitsWasm));

      const newCommitments = result.callStackItem.publicInputs.newCommitments.filter(field => !field.equals(Fr.ZERO));
      expect(newCommitments).toHaveLength(1);

      const [commitment] = newCommitments;
      expect(commitment).toEqual(
        Fr.fromBuffer(acirSimulator.computeNoteHash(newNote.storageSlot, newNote.preimage, circuitsWasm)),
      );
    }, 30_000);

    it('should run the mint function', async () => {
      const abi = ZkTokenContractAbi.functions.find(f => f.name === 'mint')!;

      const result = await runSimulator({ args: [140, owner], abi });

      expect(result.preimages.newNotes).toHaveLength(1);
      const newNote = result.preimages.newNotes[0];
      expect(newNote.storageSlot).toEqual(computeSlotForMapping(new Fr(1n), owner, circuitsWasm));

      const newCommitments = result.callStackItem.publicInputs.newCommitments.filter(field => !field.equals(Fr.ZERO));
      expect(newCommitments).toHaveLength(1);

      const [commitment] = newCommitments;
      expect(commitment).toEqual(
        Fr.fromBuffer(acirSimulator.computeNoteHash(newNote.storageSlot, newNote.preimage, circuitsWasm)),
      );
    });

    it('should run the transfer function', async () => {
      const amountToTransfer = 100n;
      const abi = ZkTokenContractAbi.functions.find(f => f.name === 'transfer')!;

      const preimages = [buildNote(60n, owner), buildNote(80n, owner)];
      const storageSlot = computeSlotForMapping(new Fr(1n), owner, circuitsWasm);
      // TODO for this we need that noir siloes the commitment the same way as the kernel does, to do merkle membership
      const leaves = preimages.map(preimage => acirSimulator.computeNoteHash(storageSlot, preimage, circuitsWasm));
      await insertLeaves(leaves);

      oracle.getNotes.mockImplementation(async () => {
        return {
          count: preimages.length,
          notes: await Promise.all(
            preimages.map((preimage, index) => ({
              preimage,
              index: BigInt(index),
            })),
          ),
        };
      });

      oracle.getSecretKey.mockReturnValue(Promise.resolve(ownerPk));

      const args = [amountToTransfer, owner, recipient];
      const result = await runSimulator({ args, abi });

      // The two notes were nullified
      const newNullifiers = result.callStackItem.publicInputs.newNullifiers.filter(field => !field.equals(Fr.ZERO));
      expect(newNullifiers).toHaveLength(2);

      expect(newNullifiers).toEqual(
        preimages.map(preimage =>
          Fr.fromBuffer(acirSimulator.computeNullifier(storageSlot, preimage, ownerPk, circuitsWasm)),
        ),
      );

      expect(result.preimages.newNotes).toHaveLength(2);
      const [changeNote, recipientNote] = result.preimages.newNotes;
      expect(recipientNote.storageSlot).toEqual(computeSlotForMapping(new Fr(1n), recipient, circuitsWasm));

      const newCommitments = result.callStackItem.publicInputs.newCommitments.filter(field => !field.equals(Fr.ZERO));

      expect(newCommitments).toHaveLength(2);

      const [changeNoteCommitment, recipientNoteCommitment] = newCommitments;
      const recipientStorageSlot = computeSlotForMapping(new Fr(1n), recipient, circuitsWasm);
      expect(recipientNoteCommitment).toEqual(
        Fr.fromBuffer(acirSimulator.computeNoteHash(recipientStorageSlot, recipientNote.preimage, circuitsWasm)),
      );
      expect(changeNoteCommitment).toEqual(
        Fr.fromBuffer(acirSimulator.computeNoteHash(storageSlot, changeNote.preimage, circuitsWasm)),
      );

      expect(recipientNote.preimage[0]).toEqual(new Fr(amountToTransfer));
      expect(changeNote.preimage[0]).toEqual(new Fr(40n));

      const readRequests = result.callStackItem.publicInputs.readRequests.filter(field => !field.equals(Fr.ZERO));
      const consumedNoteHashes = preimages.map(preimage =>
        Fr.fromBuffer(acirSimulator.computeNoteHash(storageSlot, preimage, circuitsWasm)),
      );
      expect(readRequests).toEqual(consumedNoteHashes);
    }, 30_000);

    it('should be able to transfer with dummy notes', async () => {
      const amountToTransfer = 100n;
      const balance = 160n;
      const abi = ZkTokenContractAbi.functions.find(f => f.name === 'transfer')!;

      const preimages = [buildNote(balance, owner)];
      const storageSlot = computeSlotForMapping(new Fr(1n), owner, circuitsWasm);
      // TODO for this we need that noir siloes the commitment the same way as the kernel does, to do merkle membership
      const leaves = preimages.map(preimage => acirSimulator.computeNoteHash(storageSlot, preimage, circuitsWasm));
      await insertLeaves(leaves);

      oracle.getNotes.mockImplementation(async () => {
        return {
          count: preimages.length,
          notes: await Promise.all(
            preimages.map((preimage, index) => ({
              preimage,
              index: BigInt(index),
            })),
          ),
        };
      });

      oracle.getSecretKey.mockReturnValue(Promise.resolve(ownerPk));

      const args = [amountToTransfer, owner, recipient];
      const result = await runSimulator({ args, abi });

      const newNullifiers = result.callStackItem.publicInputs.newNullifiers.filter(field => !field.equals(Fr.ZERO));
      expect(newNullifiers).toHaveLength(1);

      expect(newNullifiers[0]).toEqual(
        Fr.fromBuffer(acirSimulator.computeNullifier(storageSlot, preimages[0], ownerPk, circuitsWasm)),
      );

      expect(result.preimages.newNotes).toHaveLength(2);
      const [changeNote, recipientNote] = result.preimages.newNotes;
      expect(recipientNote.preimage[0]).toEqual(new Fr(amountToTransfer));
      expect(changeNote.preimage[0]).toEqual(new Fr(balance - amountToTransfer));
    }, 30_000);

    it('Should be able to claim a note by providing the correct secret', async () => {
      const contractAddress = AztecAddress.random();
      const amount = 100n;
      const secret = Fr.random();
      const abi = ZkTokenContractAbi.functions.find(f => f.name === 'claim')!;

      const storageSlot = 2n;
      const innerNoteHash = hash([toBufferBE(amount, 32), secret.toBuffer()]);
      const noteHash = Fr.fromBuffer(hash([toBufferBE(storageSlot, 32), innerNoteHash]));

      const result = await runSimulator({
        origin: contractAddress,
        abi,
        args: [amount, secret, recipient],
      });

      // Check a nullifier has been created.
      const newNullifiers = result.callStackItem.publicInputs.newNullifiers.filter(field => !field.equals(Fr.ZERO));
      expect(newNullifiers).toHaveLength(1);

      // Check the read request was created successfully.
      const readRequests = result.callStackItem.publicInputs.readRequests.filter(field => !field.equals(Fr.ZERO));
      expect(readRequests).toHaveLength(1);
      expect(readRequests[0]).toEqual(noteHash);
    }, 30_000);
  });

  describe('nested calls', () => {
    const privateIncrement = txContext.chainId.value + txContext.version.value;
    it('child function should be callable', async () => {
      const initialValue = 100n;
      const abi = ChildAbi.functions.find(f => f.name === 'value')!;
      const result = await runSimulator({ args: [initialValue], abi });

      expect(result.callStackItem.publicInputs.returnValues[0]).toEqual(new Fr(initialValue + privateIncrement));
    }, 30_000);

    it('parent should call child', async () => {
      const childAbi = ChildAbi.functions.find(f => f.name === 'value')!;
      const parentAbi = ParentAbi.functions.find(f => f.name === 'entryPoint')!;
      const parentAddress = AztecAddress.random();
      const childAddress = AztecAddress.random();
      const childSelector = Buffer.alloc(4, 1); // should match the call

      oracle.getFunctionABI.mockImplementation(() => Promise.resolve(childAbi));
      oracle.getPortalContractAddress.mockImplementation(() => Promise.resolve(EthAddress.ZERO));

      logger(`Parent deployed at ${parentAddress.toShortString()}`);
      logger(`Calling child function ${childSelector.toString('hex')} at ${childAddress.toShortString()}`);

      const args = [Fr.fromBuffer(childAddress.toBuffer()), Fr.fromBuffer(childSelector)];
      const result = await runSimulator({ args, abi: parentAbi, origin: parentAddress });

      expect(result.callStackItem.publicInputs.returnValues[0]).toEqual(new Fr(privateIncrement));
      expect(oracle.getFunctionABI.mock.calls[0]).toEqual([childAddress, childSelector]);
      expect(oracle.getPortalContractAddress.mock.calls[0]).toEqual([childAddress]);
      expect(result.nestedExecutions).toHaveLength(1);
      expect(result.nestedExecutions[0].callStackItem.publicInputs.returnValues[0]).toEqual(new Fr(privateIncrement));
    }, 30_000);
  });

  describe('Consuming Messages', () => {
    let recipientPk: Buffer;
    let recipient: NoirPoint;

    beforeAll(() => {
      recipientPk = Buffer.from('0c9ed344548e8f9ba8aa3c9f8651eaa2853130f6c1e9c050ccf198f7ea18a7ec', 'hex');

      const grumpkin = new Grumpkin(circuitsWasm);
      recipient = toPublicKey(recipientPk, grumpkin);
    });

    it('Should be able to consume a dummy cross chain message', async () => {
      const contractAddress = AztecAddress.random();
      const bridgedAmount = 100n;
      const abi = NonNativeTokenContractAbi.functions.find(f => f.name === 'mint')!;

      const secret = new Fr(1n);
      const canceller = EthAddress.random();
      // Function selector: 0xeeb73071 keccak256('mint(uint256,bytes32,address)')
      const preimage = await buildL1ToL2Message(
        'eeb73071',
        [new Fr(bridgedAmount), new Fr(recipient.x), canceller.toField()],
        contractAddress,
        secret,
      );

      // stub message key
      const messageKey = Fr.random();
      const tree = await insertLeaves([messageKey.toBuffer()], 'l1ToL2Messages');

      oracle.getL1ToL2Message.mockImplementation(async () => {
        return Promise.resolve({
          message: preimage.toFieldArray(),
          index: 0n,
          siblingPath: (await tree.getSiblingPath(0n, false)).toFieldArray(),
        });
      });

      const args = [bridgedAmount, recipient, recipient.x, messageKey, secret, canceller.toField()];
      const result = await runSimulator({ origin: contractAddress, contractAddress, abi, args });

      // Check a nullifier has been created
      const newNullifiers = result.callStackItem.publicInputs.newNullifiers.filter(field => !field.equals(Fr.ZERO));
      expect(newNullifiers).toHaveLength(1);
    }, 30_000);

    it('Should be able to consume a dummy public to private message', async () => {
      const contractAddress = AztecAddress.random();
      const amount = 100n;
      const abi = NonNativeTokenContractAbi.functions.find(f => f.name === 'redeemShield')!;

      const wasm = await CircuitsWasm.get();
      const secret = new Fr(1n);
      const secretHash = computeSecretMessageHash(wasm, secret);
      const commitment = Fr.fromBuffer(hash([toBufferBE(amount, 32), secretHash.toBuffer()]));
      const siloedCommitment = siloCommitment(wasm, contractAddress, commitment);

      const tree = await insertLeaves([siloedCommitment.toBuffer()]);

      oracle.getCommitmentOracle.mockImplementation(async () => {
        // Check the calculated commitment is correct
        return Promise.resolve({
          commitment: siloedCommitment,
          index: 0n,
          siblingPath: (await tree.getSiblingPath(0n, false)).toFieldArray(),
        });
      });

      const result = await runSimulator({
        origin: contractAddress,
        abi,
        args: [amount, secret, recipient],
      });

      // Check a nullifier has been created.
      const newNullifiers = result.callStackItem.publicInputs.newNullifiers.filter(field => !field.equals(Fr.ZERO));
      expect(newNullifiers).toHaveLength(1);

      // Check the commitment read request was created successfully.
      const readRequests = result.callStackItem.publicInputs.readRequests.filter(field => !field.equals(Fr.ZERO));
      expect(readRequests).toHaveLength(1);
      expect(readRequests[0]).toEqual(commitment);
    }, 30_000);
  });

  describe('enqueued calls', () => {
    it('parent should enqueue call to child', async () => {
      const parentAbi = ParentAbi.functions.find(f => f.name === 'enqueueCallToChild')!;
      const childAddress = AztecAddress.random();
      const childPortalContractAddress = EthAddress.random();
      const childSelector = Buffer.alloc(4, 1); // should match the call
      const parentAddress = AztecAddress.random();

      oracle.getPortalContractAddress.mockImplementation(() => Promise.resolve(childPortalContractAddress));

      const args = [Fr.fromBuffer(childAddress.toBuffer()), Fr.fromBuffer(childSelector), 42n];
      const result = await runSimulator({
        origin: parentAddress,
        contractAddress: parentAddress,
        abi: parentAbi,
        args,
      });

      expect(result.enqueuedPublicFunctionCalls).toHaveLength(1);
      expect(result.enqueuedPublicFunctionCalls[0]).toEqual(
        PublicCallRequest.from({
          contractAddress: childAddress,
          functionData: new FunctionData(childSelector, false, false),
          args: [new Fr(42n)],
          callContext: CallContext.from({
            msgSender: parentAddress,
            storageContractAddress: childAddress,
            portalContractAddress: childPortalContractAddress,
            isContractDeployment: false,
            isDelegateCall: false,
            isStaticCall: false,
          }),
        }),
      );
    });
  });
});
