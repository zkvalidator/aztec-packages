import {
  type AuthWitness,
  type AztecNode,
  EventMetadata,
  type EventMetadataDefinition,
  type ExtendedNote,
  type FunctionCall,
  type GetUnencryptedLogsResponse,
  type InBlock,
  type IncomingNotesFilter,
  L1EventPayload,
  type L2Block,
  type LogFilter,
  MerkleTreeId,
  type OutgoingNotesFilter,
  type PXE,
  type PXEInfo,
  type PrivateExecutionResult,
  type PrivateKernelProver,
  type PrivateKernelSimulateOutput,
  PrivateSimulationResult,
  type PublicSimulationOutput,
  type SiblingPath,
  SimulationError,
  type Tx,
  type TxEffect,
  type TxExecutionRequest,
  type TxHash,
  TxProvingResult,
  type TxReceipt,
  TxSimulationResult,
  UniqueNote,
  getNonNullifiedL1ToL2MessageWitness,
} from '@aztec/circuit-types';
import {
  type AztecAddress,
  type CompleteAddress,
  type ContractClassWithId,
  type ContractInstanceWithAddress,
  type GasFees,
  type L1_TO_L2_MSG_TREE_HEIGHT,
  type NodeInfo,
  type PartialAddress,
  type PrivateKernelTailCircuitPublicInputs,
  computeAddressSecret,
  computeContractAddressFromInstance,
  computeContractClassId,
  getContractClassFromArtifact,
} from '@aztec/circuits.js';
import { computeNoteHashNonce, siloNullifier } from '@aztec/circuits.js/hash';
import {
  type AbiDecoded,
  type ContractArtifact,
  EventSelector,
  FunctionSelector,
  encodeArguments,
} from '@aztec/foundation/abi';
import { Fr, type Point } from '@aztec/foundation/fields';
import { type DebugLogger, createDebugLogger } from '@aztec/foundation/log';
import { SerialQueue } from '@aztec/foundation/queue';
import { type KeyStore } from '@aztec/key-store';
import { type L2TipsStore } from '@aztec/kv-store/stores';
import {
  ProtocolContractAddress,
  getCanonicalProtocolContract,
  protocolContractNames,
} from '@aztec/protocol-contracts';
import { type AcirSimulator } from '@aztec/simulator';

import { type PXEServiceConfig, getPackageInfo } from '../config/index.js';
import { ContractDataOracle } from '../contract_data_oracle/index.js';
import { IncomingNoteDao } from '../database/incoming_note_dao.js';
import { type PxeDatabase } from '../database/index.js';
import { KernelOracle } from '../kernel_oracle/index.js';
import { KernelProver } from '../kernel_prover/kernel_prover.js';
import { TestPrivateKernelProver } from '../kernel_prover/test/test_circuit_prover.js';
import { getAcirSimulator } from '../simulator/index.js';
import { Synchronizer } from '../synchronizer/index.js';
import { enrichPublicSimulationError, enrichSimulationError } from './error_enriching.js';

/**
 * A Private eXecution Environment (PXE) implementation.
 */
export class PXEService implements PXE {
  private synchronizer: Synchronizer;
  private contractDataOracle: ContractDataOracle;
  private simulator: AcirSimulator;
  private log: DebugLogger;
  private packageVersion: string;
  // serialize synchronizer and calls to proveTx.
  // ensures that state is not changed while simulating
  private jobQueue = new SerialQueue();

  constructor(
    private keyStore: KeyStore,
    private node: AztecNode,
    private db: PxeDatabase,
    tipsStore: L2TipsStore,
    private proofCreator: PrivateKernelProver,
    config: PXEServiceConfig,
    logSuffix?: string,
  ) {
    this.log = createDebugLogger(logSuffix ? `aztec:pxe_service_${logSuffix}` : `aztec:pxe_service`);
    this.synchronizer = new Synchronizer(node, db, tipsStore, config, logSuffix);
    this.contractDataOracle = new ContractDataOracle(db);
    this.simulator = getAcirSimulator(db, node, keyStore, this.contractDataOracle);
    this.packageVersion = getPackageInfo().version;

    this.jobQueue.start();
  }

  /**
   * Starts the PXE Service by beginning the synchronization process between the Aztec node and the database.
   *
   * @returns A promise that resolves when the server has started successfully.
   */
  public async start() {
    await this.synchronizer.start();
    await this.#registerProtocolContracts();
    const info = await this.getNodeInfo();
    this.log.info(`Started PXE connected to chain ${info.l1ChainId} version ${info.protocolVersion}`);
  }

  /**
   * Stops the PXE Service, halting processing of new transactions and shutting down the synchronizer.
   * This function ensures that all ongoing tasks are completed before stopping the server.
   * It is useful for gracefully shutting down the server during maintenance or restarts.
   *
   * @returns A Promise resolving once the server has been stopped successfully.
   */
  public async stop() {
    await this.jobQueue.cancel();
    this.log.info('Cancelled Job Queue');
    await this.synchronizer.stop();
    this.log.info('Stopped Synchronizer');
  }

  /** Returns an estimate of the db size in bytes. */
  public estimateDbSize() {
    return this.db.estimateSize();
  }

  public addAuthWitness(witness: AuthWitness) {
    return this.db.addAuthWitness(witness.requestHash, witness.witness);
  }

  public getAuthWitness(messageHash: Fr): Promise<Fr[] | undefined> {
    return this.db.getAuthWitness(messageHash);
  }

  public addCapsule(capsule: Fr[]) {
    return this.db.addCapsule(capsule);
  }

  public getContractInstance(address: AztecAddress): Promise<ContractInstanceWithAddress | undefined> {
    return this.db.getContractInstance(address);
  }

  public async getContractClass(id: Fr): Promise<ContractClassWithId | undefined> {
    const artifact = await this.db.getContractArtifact(id);
    return artifact && getContractClassFromArtifact(artifact);
  }

  public getContractArtifact(id: Fr): Promise<ContractArtifact | undefined> {
    return this.db.getContractArtifact(id);
  }

  public async registerAccount(secretKey: Fr, partialAddress: PartialAddress): Promise<CompleteAddress> {
    const accounts = await this.keyStore.getAccounts();
    const accountCompleteAddress = await this.keyStore.addAccount(secretKey, partialAddress);
    if (accounts.includes(accountCompleteAddress.address)) {
      this.log.info(`Account:\n "${accountCompleteAddress.address.toString()}"\n already registered.`);
      return accountCompleteAddress;
    } else {
      this.log.info(`Registered account ${accountCompleteAddress.address.toString()}`);
      this.log.debug(`Registered account\n ${accountCompleteAddress.toReadableString()}`);
    }

    await this.db.addCompleteAddress(accountCompleteAddress);
    return accountCompleteAddress;
  }

  public async registerContact(address: AztecAddress): Promise<AztecAddress> {
    const accounts = await this.keyStore.getAccounts();
    if (accounts.includes(address)) {
      this.log.info(`Account:\n "${address.toString()}"\n already registered.`);
      return address;
    }

    const wasAdded = await this.db.addContactAddress(address);

    if (wasAdded) {
      this.log.info(`Added contact:\n ${address.toString()}`);
    } else {
      this.log.info(`Contact:\n "${address.toString()}"\n already registered.`);
    }

    return address;
  }

  public getContacts(): Promise<AztecAddress[]> {
    const contacts = this.db.getContactAddresses();

    return Promise.resolve(contacts);
  }

  public async removeContact(address: AztecAddress): Promise<void> {
    const wasRemoved = await this.db.removeContactAddress(address);

    if (wasRemoved) {
      this.log.info(`Removed contact:\n ${address.toString()}`);
    } else {
      this.log.info(`Contact:\n "${address.toString()}"\n not in address book.`);
    }

    return Promise.resolve();
  }

  public async getRegisteredAccounts(): Promise<CompleteAddress[]> {
    // Get complete addresses of both the recipients and the accounts
    const completeAddresses = await this.db.getCompleteAddresses();
    // Filter out the addresses not corresponding to accounts
    const accounts = await this.keyStore.getAccounts();
    return completeAddresses.filter(completeAddress =>
      accounts.find(address => address.equals(completeAddress.address)),
    );
  }

  public async getRegisteredAccount(address: AztecAddress): Promise<CompleteAddress | undefined> {
    const result = await this.getRegisteredAccounts();
    const account = result.find(r => r.address.equals(address));
    return Promise.resolve(account);
  }

  public async registerContractClass(artifact: ContractArtifact): Promise<void> {
    const contractClassId = computeContractClassId(getContractClassFromArtifact(artifact));
    await this.db.addContractArtifact(contractClassId, artifact);
    this.log.info(`Added contract class ${artifact.name} with id ${contractClassId}`);
  }

  public async registerContract(contract: { instance: ContractInstanceWithAddress; artifact?: ContractArtifact }) {
    const { instance } = contract;
    let { artifact } = contract;

    if (artifact) {
      // If the user provides an artifact, validate it against the expected class id and register it
      const contractClass = getContractClassFromArtifact(artifact);
      const contractClassId = computeContractClassId(contractClass);
      if (!contractClassId.equals(instance.contractClassId)) {
        throw new Error(
          `Artifact does not match expected class id (computed ${contractClassId} but instance refers to ${instance.contractClassId})`,
        );
      }
      if (!computeContractAddressFromInstance(instance).equals(instance.address)) {
        throw new Error('Added a contract in which the address does not match the contract instance.');
      }

      await this.db.addContractArtifact(contractClassId, artifact);

      // TODO: PXE may not want to broadcast the artifact to the network
      await this.node.addContractArtifact(instance.address, artifact);

      // TODO(#10007): Node should get public contract class from the registration event, not from PXE registration
      await this.node.addContractClass({ ...contractClass, privateFunctions: [], unconstrainedFunctions: [] });
    } else {
      // Otherwise, make sure there is an artifact already registered for that class id
      artifact = await this.db.getContractArtifact(instance.contractClassId);
      if (!artifact) {
        throw new Error(
          `Missing contract artifact for class id ${instance.contractClassId} for contract ${instance.address}`,
        );
      }
    }

    this.log.info(`Added contract ${artifact.name} at ${instance.address.toString()}`);
    await this.db.addContractInstance(instance);
  }

  public getContracts(): Promise<AztecAddress[]> {
    return this.db.getContractsAddresses();
  }

  public async getPublicStorageAt(contract: AztecAddress, slot: Fr) {
    if (!(await this.getContractInstance(contract))) {
      throw new Error(`Contract ${contract.toString()} is not deployed`);
    }
    return await this.node.getPublicStorageAt(contract, slot, 'latest');
  }

  public async getIncomingNotes(filter: IncomingNotesFilter): Promise<UniqueNote[]> {
    const noteDaos = await this.db.getIncomingNotes(filter);

    const extendedNotes = noteDaos.map(async dao => {
      let owner = filter.owner;
      if (owner === undefined) {
        const completeAddresses = (await this.db.getCompleteAddresses()).find(completeAddress =>
          completeAddress.address.toAddressPoint().equals(dao.addressPoint),
        );
        if (completeAddresses === undefined) {
          throw new Error(`Cannot find complete address for addressPoint ${dao.addressPoint.toString()}`);
        }
        owner = completeAddresses.address;
      }
      return new UniqueNote(
        dao.note,
        owner,
        dao.contractAddress,
        dao.storageSlot,
        dao.noteTypeId,
        dao.txHash,
        dao.nonce,
      );
    });
    return Promise.all(extendedNotes);
  }

  public async getOutgoingNotes(filter: OutgoingNotesFilter): Promise<UniqueNote[]> {
    const noteDaos = await this.db.getOutgoingNotes(filter);

    const extendedNotes = noteDaos.map(async dao => {
      let owner = filter.owner;
      if (owner === undefined) {
        const completeAddresses = (await this.db.getCompleteAddresses()).find(address =>
          address.publicKeys.masterOutgoingViewingPublicKey.equals(dao.ovpkM),
        );
        if (completeAddresses === undefined) {
          throw new Error(`Cannot find complete address for OvpkM ${dao.ovpkM.toString()}`);
        }
        owner = completeAddresses.address;
      }
      return new UniqueNote(
        dao.note,
        owner,
        dao.contractAddress,
        dao.storageSlot,
        dao.noteTypeId,
        dao.txHash,
        dao.nonce,
      );
    });
    return Promise.all(extendedNotes);
  }

  public async getL1ToL2MembershipWitness(
    contractAddress: AztecAddress,
    messageHash: Fr,
    secret: Fr,
  ): Promise<[bigint, SiblingPath<typeof L1_TO_L2_MSG_TREE_HEIGHT>]> {
    return await getNonNullifiedL1ToL2MessageWitness(this.node, contractAddress, messageHash, secret);
  }

  public async addNote(note: ExtendedNote, scope?: AztecAddress) {
    const owner = await this.db.getCompleteAddress(note.owner);
    if (!owner) {
      throw new Error(`Unknown account: ${note.owner.toString()}`);
    }

    const { data: nonces, l2BlockNumber, l2BlockHash } = await this.#getNoteNonces(note);
    if (nonces.length === 0) {
      throw new Error(`Cannot find the note in tx: ${note.txHash}.`);
    }

    for (const nonce of nonces) {
      const { noteHash, siloedNoteHash, innerNullifier } = await this.simulator.computeNoteHashAndOptionallyANullifier(
        note.contractAddress,
        nonce,
        note.storageSlot,
        note.noteTypeId,
        true,
        note.note,
      );

      const [index] = await this.node.findLeavesIndexes('latest', MerkleTreeId.NOTE_HASH_TREE, [siloedNoteHash]);
      if (index === undefined) {
        throw new Error('Note does not exist.');
      }

      const siloedNullifier = siloNullifier(note.contractAddress, innerNullifier!);
      const [nullifierIndex] = await this.node.findLeavesIndexes('latest', MerkleTreeId.NULLIFIER_TREE, [
        siloedNullifier,
      ]);
      if (nullifierIndex !== undefined) {
        throw new Error('The note has been destroyed.');
      }

      await this.db.addNote(
        new IncomingNoteDao(
          note.note,
          note.contractAddress,
          note.storageSlot,
          note.noteTypeId,
          note.txHash,
          l2BlockNumber,
          l2BlockHash,
          nonce,
          noteHash,
          siloedNullifier,
          index,
          owner.address.toAddressPoint(),
        ),
        scope,
      );
    }
  }

  public async addNullifiedNote(note: ExtendedNote) {
    const { data: nonces, l2BlockHash, l2BlockNumber } = await this.#getNoteNonces(note);
    if (nonces.length === 0) {
      throw new Error(`Cannot find the note in tx: ${note.txHash}.`);
    }

    for (const nonce of nonces) {
      const { noteHash, siloedNoteHash, innerNullifier } = await this.simulator.computeNoteHashAndOptionallyANullifier(
        note.contractAddress,
        nonce,
        note.storageSlot,
        note.noteTypeId,
        false,
        note.note,
      );

      if (!innerNullifier.equals(Fr.ZERO)) {
        throw new Error('Unexpectedly received non-zero nullifier.');
      }

      const [index] = await this.node.findLeavesIndexes('latest', MerkleTreeId.NOTE_HASH_TREE, [siloedNoteHash]);
      if (index === undefined) {
        throw new Error('Note does not exist.');
      }

      await this.db.addNullifiedNote(
        new IncomingNoteDao(
          note.note,
          note.contractAddress,
          note.storageSlot,
          note.noteTypeId,
          note.txHash,
          l2BlockNumber,
          l2BlockHash,
          nonce,
          noteHash,
          Fr.ZERO, // We are not able to derive
          index,
          note.owner.toAddressPoint(),
        ),
      );
    }
  }

  /**
   * Finds the nonce(s) for a given note.
   * @param note - The note to find the nonces for.
   * @returns The nonces of the note.
   * @remarks More than a single nonce may be returned since there might be more than one nonce for a given note.
   */
  async #getNoteNonces(note: ExtendedNote): Promise<InBlock<Fr[]>> {
    const tx = await this.node.getTxEffect(note.txHash);
    if (!tx) {
      throw new Error(`Unknown tx: ${note.txHash}`);
    }

    const nonces: Fr[] = [];
    const firstNullifier = tx.data.nullifiers[0];
    const hashes = tx.data.noteHashes;
    for (let i = 0; i < hashes.length; ++i) {
      const hash = hashes[i];
      if (hash.equals(Fr.ZERO)) {
        break;
      }

      const nonce = computeNoteHashNonce(firstNullifier, i);
      const { siloedNoteHash } = await this.simulator.computeNoteHashAndOptionallyANullifier(
        note.contractAddress,
        nonce,
        note.storageSlot,
        note.noteTypeId,
        false,
        note.note,
      );
      if (hash.equals(siloedNoteHash)) {
        nonces.push(nonce);
      }
    }

    return { l2BlockHash: tx.l2BlockHash, l2BlockNumber: tx.l2BlockNumber, data: nonces };
  }

  public async getBlock(blockNumber: number): Promise<L2Block | undefined> {
    // If a negative block number is provided the current block number is fetched.
    if (blockNumber < 0) {
      blockNumber = await this.node.getBlockNumber();
    }
    return await this.node.getBlock(blockNumber);
  }

  public async getCurrentBaseFees(): Promise<GasFees> {
    return await this.node.getCurrentBaseFees();
  }

  async #simulateKernels(
    txRequest: TxExecutionRequest,
    privateExecutionResult: PrivateExecutionResult,
  ): Promise<PrivateKernelTailCircuitPublicInputs> {
    const result = await this.#prove(txRequest, new TestPrivateKernelProver(), privateExecutionResult);
    return result.publicInputs;
  }

  public proveTx(
    txRequest: TxExecutionRequest,
    privateExecutionResult: PrivateExecutionResult,
  ): Promise<TxProvingResult> {
    return this.jobQueue
      .put(async () => {
        const { publicInputs, clientIvcProof } = await this.#prove(
          txRequest,
          this.proofCreator,
          privateExecutionResult,
        );
        return new TxProvingResult(privateExecutionResult, publicInputs, clientIvcProof!);
      })
      .catch(err => {
        this.log.error(err);
        throw err;
      });
  }

  // TODO(#7456) Prevent msgSender being defined here for the first call
  public async simulateTx(
    txRequest: TxExecutionRequest,
    simulatePublic: boolean,
    msgSender: AztecAddress | undefined = undefined,
    skipTxValidation: boolean = false,
    profile: boolean = false,
    scopes?: AztecAddress[],
  ): Promise<TxSimulationResult> {
    return await this.jobQueue
      .put(async () => {
        const privateExecutionResult = await this.#executePrivate(txRequest, msgSender, scopes);

        let publicInputs: PrivateKernelTailCircuitPublicInputs;
        let profileResult;
        if (profile) {
          ({ publicInputs, profileResult } = await this.#profileKernelProver(
            txRequest,
            this.proofCreator,
            privateExecutionResult,
          ));
        } else {
          publicInputs = await this.#simulateKernels(txRequest, privateExecutionResult);
        }

        const privateSimulationResult = new PrivateSimulationResult(privateExecutionResult, publicInputs);
        const simulatedTx = privateSimulationResult.toSimulatedTx();
        let publicOutput: PublicSimulationOutput | undefined;
        if (simulatePublic) {
          publicOutput = await this.#simulatePublicCalls(simulatedTx);
        }

        if (!skipTxValidation) {
          if (!(await this.node.isValidTx(simulatedTx, true))) {
            throw new Error('The simulated transaction is unable to be added to state and is invalid.');
          }
        }

        // We log only if the msgSender is undefined, as simulating with a different msgSender
        // is unlikely to be a real transaction, and likely to be only used to read data.
        // Meaning that it will not necessarily have produced a nullifier (and thus have no TxHash)
        // If we log, the `getTxHash` function will throw.
        if (!msgSender) {
          this.log.info(`Executed local simulation for ${simulatedTx.getTxHash()}`);
        }
        return TxSimulationResult.fromPrivateSimulationResultAndPublicOutput(
          privateSimulationResult,
          publicOutput,
          profileResult,
        );
      })
      .catch(err => {
        this.log.error(err);
        throw err;
      });
  }

  public async sendTx(tx: Tx): Promise<TxHash> {
    const txHash = tx.getTxHash();
    if (await this.node.getTxEffect(txHash)) {
      throw new Error(`A settled tx with equal hash ${txHash.toString()} exists.`);
    }
    this.log.info(`Sending transaction ${txHash}`);
    await this.node.sendTx(tx).catch(err => {
      this.log.error(err);
      throw err;
    });
    this.log.info(`Sent transaction ${txHash}`);
    return txHash;
  }

  public async simulateUnconstrained(
    functionName: string,
    args: any[],
    to: AztecAddress,
    _from?: AztecAddress,
    scopes?: AztecAddress[],
  ): Promise<AbiDecoded> {
    // all simulations must be serialized w.r.t. the synchronizer
    return await this.jobQueue
      .put(async () => {
        // TODO - Should check if `from` has the permission to call the view function.
        const functionCall = await this.#getFunctionCall(functionName, args, to);
        const executionResult = await this.#simulateUnconstrained(functionCall, scopes);

        // TODO - Return typed result based on the function artifact.
        return executionResult;
      })
      .catch(err => {
        this.log.error(err);
        throw err;
      });
  }

  public getTxReceipt(txHash: TxHash): Promise<TxReceipt> {
    return this.node.getTxReceipt(txHash);
  }

  public getTxEffect(txHash: TxHash): Promise<InBlock<TxEffect> | undefined> {
    return this.node.getTxEffect(txHash);
  }

  public async getBlockNumber(): Promise<number> {
    return await this.node.getBlockNumber();
  }

  public async getProvenBlockNumber(): Promise<number> {
    return await this.node.getProvenBlockNumber();
  }

  /**
   * Gets unencrypted logs based on the provided filter.
   * @param filter - The filter to apply to the logs.
   * @returns The requested logs.
   */
  public getUnencryptedLogs(filter: LogFilter): Promise<GetUnencryptedLogsResponse> {
    return this.node.getUnencryptedLogs(filter);
  }

  /**
   * Gets contract class logs based on the provided filter.
   * @param filter - The filter to apply to the logs.
   * @returns The requested logs.
   */
  public getContractClassLogs(filter: LogFilter): Promise<GetUnencryptedLogsResponse> {
    return this.node.getContractClassLogs(filter);
  }

  async #getFunctionCall(functionName: string, args: any[], to: AztecAddress): Promise<FunctionCall> {
    const contract = await this.db.getContract(to);
    if (!contract) {
      throw new Error(
        `Unknown contract ${to}: add it to PXE Service by calling server.addContracts(...).\nSee docs for context: https://docs.aztec.network/reference/common_errors/aztecnr-errors#unknown-contract-0x0-add-it-to-pxe-by-calling-serveraddcontracts`,
      );
    }

    const functionDao = contract.functions.find(f => f.name === functionName);
    if (!functionDao) {
      throw new Error(`Unknown function ${functionName} in contract ${contract.name}.`);
    }

    return {
      name: functionDao.name,
      args: encodeArguments(functionDao, args),
      selector: FunctionSelector.fromNameAndParameters(functionDao.name, functionDao.parameters),
      type: functionDao.functionType,
      to,
      isStatic: functionDao.isStatic,
      returnTypes: functionDao.returnTypes,
    };
  }

  public async getNodeInfo(): Promise<NodeInfo> {
    const [nodeVersion, protocolVersion, chainId, enr, contractAddresses, protocolContractAddresses] =
      await Promise.all([
        this.node.getNodeVersion(),
        this.node.getVersion(),
        this.node.getChainId(),
        this.node.getEncodedEnr(),
        this.node.getL1ContractAddresses(),
        this.node.getProtocolContractAddresses(),
      ]);

    const nodeInfo: NodeInfo = {
      nodeVersion,
      l1ChainId: chainId,
      protocolVersion,
      enr,
      l1ContractAddresses: contractAddresses,
      protocolContractAddresses: protocolContractAddresses,
    };

    return nodeInfo;
  }

  public getPXEInfo(): Promise<PXEInfo> {
    return Promise.resolve({
      pxeVersion: this.packageVersion,
      protocolContractAddresses: {
        classRegisterer: ProtocolContractAddress.ContractClassRegisterer,
        feeJuice: ProtocolContractAddress.FeeJuice,
        instanceDeployer: ProtocolContractAddress.ContractInstanceDeployer,
        multiCallEntrypoint: ProtocolContractAddress.MultiCallEntrypoint,
      },
    });
  }

  async #registerProtocolContracts() {
    for (const name of protocolContractNames) {
      const { address, contractClass, instance, artifact } = getCanonicalProtocolContract(name);
      await this.db.addContractArtifact(contractClass.id, artifact);
      await this.db.addContractInstance(instance);
      this.log.info(`Added protocol contract ${name} at ${address.toString()}`);
    }
  }

  /**
   * Retrieves the simulation parameters required to run an ACIR simulation.
   * This includes the contract address, function artifact, and historical tree roots.
   *
   * @param execRequest - The transaction request object containing details of the contract call.
   * @returns An object containing the contract address, function artifact, and historical tree roots.
   */
  async #getSimulationParameters(execRequest: FunctionCall | TxExecutionRequest) {
    const contractAddress = (execRequest as FunctionCall).to ?? (execRequest as TxExecutionRequest).origin;
    const functionSelector =
      (execRequest as FunctionCall).selector ?? (execRequest as TxExecutionRequest).functionSelector;
    const functionArtifact = await this.contractDataOracle.getFunctionArtifact(contractAddress, functionSelector);
    const debug = await this.contractDataOracle.getFunctionDebugMetadata(contractAddress, functionSelector);

    return {
      contractAddress,
      functionArtifact: {
        ...functionArtifact,
        debug,
      },
    };
  }

  async #executePrivate(
    txRequest: TxExecutionRequest,
    msgSender?: AztecAddress,
    scopes?: AztecAddress[],
  ): Promise<PrivateExecutionResult> {
    // TODO - Pause syncing while simulating.

    const { contractAddress, functionArtifact } = await this.#getSimulationParameters(txRequest);

    this.log.debug('Executing simulator...');
    try {
      const result = await this.simulator.run(txRequest, functionArtifact, contractAddress, msgSender, scopes);
      this.log.verbose(`Simulation completed for ${contractAddress.toString()}:${functionArtifact.name}`);
      return result;
    } catch (err) {
      if (err instanceof SimulationError) {
        await enrichSimulationError(err, this.db, this.log);
      }
      throw err;
    }
  }

  /**
   * Simulate an unconstrained transaction on the given contract, without considering constraints set by ACIR.
   * The simulation parameters are fetched using ContractDataOracle and executed using AcirSimulator.
   * Returns the simulation result containing the outputs of the unconstrained function.
   *
   * @param execRequest - The transaction request object containing the target contract and function data.
   * @param scopes - The accounts whose notes we can access in this call. Currently optional and will default to all.
   * @returns The simulation result containing the outputs of the unconstrained function.
   */
  async #simulateUnconstrained(execRequest: FunctionCall, scopes?: AztecAddress[]) {
    const { contractAddress, functionArtifact } = await this.#getSimulationParameters(execRequest);

    this.log.debug('Executing unconstrained simulator...');
    try {
      const result = await this.simulator.runUnconstrained(execRequest, functionArtifact, contractAddress, scopes);
      this.log.verbose(`Unconstrained simulation for ${contractAddress}.${functionArtifact.name} completed`);

      return result;
    } catch (err) {
      if (err instanceof SimulationError) {
        await enrichSimulationError(err, this.db, this.log);
      }
      throw err;
    }
  }

  /**
   * Simulate the public part of a transaction.
   * This allows to catch public execution errors before submitting the transaction.
   * It can also be used for estimating gas in the future.
   * @param tx - The transaction to be simulated.
   */
  async #simulatePublicCalls(tx: Tx) {
    // Simulating public calls can throw if the TX fails in a phase that doesn't allow reverts (setup)
    // Or return as reverted if it fails in a phase that allows reverts (app logic, teardown)
    try {
      const result = await this.node.simulatePublicCalls(tx);
      if (result.revertReason) {
        throw result.revertReason;
      }
      return result;
    } catch (err) {
      if (err instanceof SimulationError) {
        try {
          await enrichPublicSimulationError(err, this.contractDataOracle, this.db, this.log);
        } catch (enrichErr) {
          this.log.error(`Failed to enrich public simulation error: ${enrichErr}`);
        }
      }
      throw err;
    }
  }

  async #profileKernelProver(
    txExecutionRequest: TxExecutionRequest,
    proofCreator: PrivateKernelProver,
    privateExecutionResult: PrivateExecutionResult,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelTailCircuitPublicInputs>> {
    const block = privateExecutionResult.publicInputs.historicalHeader.globalVariables.blockNumber.toNumber();
    const kernelOracle = new KernelOracle(this.contractDataOracle, this.keyStore, this.node, block);
    const kernelProver = new KernelProver(kernelOracle, proofCreator);

    // Dry run the prover with profiler enabled
    const result = await kernelProver.prove(txExecutionRequest.toTxRequest(), privateExecutionResult, true, true);
    return result;
  }

  /**
   * Simulate a transaction, generate a kernel proof, and create a private transaction object.
   * The function takes in a transaction request, simulates it, and then generates a kernel proof
   * using the simulation result. Finally, it creates a private
   * transaction object with the generated proof and public inputs. If a new contract address is provided,
   * the function will also include the new contract's public functions in the transaction object.
   *
   * @param txExecutionRequest - The transaction request to be simulated and proved.
   * @param proofCreator - The proof creator to use for proving the execution.
   * @param msgSender - (Optional) The message sender to use for the simulation.
   * @param scopes - The accounts whose notes we can access in this call. Currently optional and will default to all.
   * @returns An object that contains:
   * A private transaction object containing the proof, public inputs, and encrypted logs.
   * The return values of the private execution
   */
  async #prove(
    txExecutionRequest: TxExecutionRequest,
    proofCreator: PrivateKernelProver,
    privateExecutionResult: PrivateExecutionResult,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelTailCircuitPublicInputs>> {
    // use the block the tx was simulated against
    const block = privateExecutionResult.publicInputs.historicalHeader.globalVariables.blockNumber.toNumber();
    const kernelOracle = new KernelOracle(this.contractDataOracle, this.keyStore, this.node, block);
    const kernelProver = new KernelProver(kernelOracle, proofCreator);
    this.log.debug(`Executing kernel prover...`);
    return await kernelProver.prove(txExecutionRequest.toTxRequest(), privateExecutionResult);
  }

  public async isGlobalStateSynchronized() {
    return await this.synchronizer.isGlobalStateSynchronized();
  }

  public getSyncStatus() {
    return Promise.resolve(this.synchronizer.getSyncStatus());
  }

  public async isContractClassPubliclyRegistered(id: Fr): Promise<boolean> {
    return !!(await this.node.getContractClass(id));
  }

  public async isContractPubliclyDeployed(address: AztecAddress): Promise<boolean> {
    return !!(await this.node.getContract(address));
  }

  public async isContractInitialized(address: AztecAddress): Promise<boolean> {
    const initNullifier = siloNullifier(address, address.toField());
    return !!(await this.node.getNullifierMembershipWitness('latest', initNullifier));
  }

  public async getEncryptedEvents<T>(
    eventMetadataDef: EventMetadataDefinition,
    from: number,
    limit: number,
    // TODO (#9272): Make this better, we should be able to only pass an address now
    vpks: Point[],
  ): Promise<T[]> {
    const eventMetadata = new EventMetadata<T>(eventMetadataDef);
    if (vpks.length === 0) {
      throw new Error('Tried to get encrypted events without supplying any viewing public keys');
    }

    const blocks = await this.node.getBlocks(from, limit);

    const txEffects = blocks.flatMap(block => block.body.txEffects);
    const encryptedTxLogs = txEffects.flatMap(txEffect => txEffect.encryptedLogs);

    const encryptedLogs = encryptedTxLogs.flatMap(encryptedTxLog => encryptedTxLog.unrollLogs());

    const vsks = await Promise.all(
      vpks.map(async vpk => {
        const [keyPrefix, account] = this.keyStore.getKeyPrefixAndAccount(vpk);
        let secretKey = await this.keyStore.getMasterSecretKey(vpk);
        if (keyPrefix === 'iv') {
          const registeredAccount = await this.getRegisteredAccount(account);
          if (!registeredAccount) {
            throw new Error('No registered account');
          }

          const preaddress = registeredAccount.getPreaddress();

          secretKey = computeAddressSecret(preaddress, secretKey);
        }

        return secretKey;
      }),
    );

    const visibleEvents = encryptedLogs.flatMap(encryptedLog => {
      for (const sk of vsks) {
        const decryptedEvent =
          L1EventPayload.decryptAsIncoming(encryptedLog, sk) ?? L1EventPayload.decryptAsOutgoing(encryptedLog, sk);
        if (decryptedEvent !== undefined) {
          return [decryptedEvent];
        }
      }

      return [];
    });

    const decodedEvents = visibleEvents
      .map(visibleEvent => {
        if (visibleEvent === undefined) {
          return undefined;
        }
        if (!visibleEvent.eventTypeId.equals(eventMetadata.eventSelector)) {
          return undefined;
        }
        if (visibleEvent.event.items.length !== eventMetadata.fieldNames.length) {
          throw new Error(
            'Something is weird here, we have matching EventSelectors, but the actual payload has mismatched length',
          );
        }

        return eventMetadata.decode(visibleEvent);
      })
      .filter(visibleEvent => visibleEvent !== undefined) as T[];

    return decodedEvents;
  }

  async getUnencryptedEvents<T>(eventMetadataDef: EventMetadataDefinition, from: number, limit: number): Promise<T[]> {
    const eventMetadata = new EventMetadata<T>(eventMetadataDef);
    const { logs: unencryptedLogs } = await this.node.getUnencryptedLogs({
      fromBlock: from,
      toBlock: from + limit,
    });

    const decodedEvents = unencryptedLogs
      .map(unencryptedLog => {
        const unencryptedLogBuf = unencryptedLog.log.data;
        // We are assuming here that event logs are the last 4 bytes of the event. This is not enshrined but is a function of aztec.nr raw log emission.
        if (
          !EventSelector.fromBuffer(unencryptedLogBuf.subarray(unencryptedLogBuf.byteLength - 4)).equals(
            eventMetadata.eventSelector,
          )
        ) {
          return undefined;
        }

        if (unencryptedLogBuf.byteLength !== eventMetadata.fieldNames.length * 32 + 32) {
          throw new Error(
            'Something is weird here, we have matching EventSelectors, but the actual payload has mismatched length',
          );
        }

        return eventMetadata.decode(unencryptedLog.log);
      })
      .filter(unencryptedLog => unencryptedLog !== undefined) as T[];

    return decodedEvents;
  }

  async resetNoteSyncData() {
    return await this.db.resetNoteSyncData();
  }
}
