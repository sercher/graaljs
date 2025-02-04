/*
 * Copyright (c) 2023, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at http://oss.oracle.com/licenses/upl.
 */

/**
 * Multithreaded Wasm tests using atomic instructions
 *
 * @option webassembly
 * @option test262-mode
 * @option wasm.Threads
 * @option wasm.UseUnsafeMemory
 */

load('../js/assert.js');
load('../../../../graal-nodejs/deps/v8/test/mjsunit/wasm/wasm-module-builder.js');

const NUM_ITERATIONS = 500000;

(function TestNaiveMutex() {
    let memory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
    let builder = new WasmModuleBuilder();
    builder.addImportedMemory("env", "imported_mem", 1, 1, "shared");
    // Try to lock a mutex at the given address.
    // Returns 1 if the mutex was successfully locked, and 0 otherwise.
    builder.addFunction("tryLockMutex", kSig_i_i)
        .addBody([
        kExprLocalGet, 0,   // mutex address
        ...wasmI32Const(0), // expected value (0 => unlocked)
        ...wasmI32Const(1), // replacement value (1 => locked)
        kAtomicPrefix,
        kExprI32AtomicCompareExchange, 2, 0,
        kExprI32Eqz])
        .exportFunc();
    // Lock a mutex at the given address, retrying until successful.
    builder.addFunction("lockMutex", kSig_v_i)
        .addBody([
        kExprBlock, kWasmVoid,
            kExprLoop, kWasmVoid,
                // Try to lock the mutex. $tryLockMutex returns 1 if the mutex
                // was locked, and 0 otherwise.
                kExprLocalGet, 0,
                kExprCallFunction, 0,
                kExprBrIf, 1,
                // Wait for the other agent to finish with mutex.
                kExprLocalGet, 0,    // mutex address
                ...wasmI32Const(1),  // expected value (1 => locked)
                ...wasmI64Const(-1), // infinite timeout
                kAtomicPrefix,
                kExprI32AtomicWait, 2, 0,
                // Ignore the result and try to acquire the mutex again.
                kExprDrop,
                kExprBr, 0,
            kExprEnd,
        kExprEnd])
        .exportFunc();
    // Unlock a mutex at the given address.
    builder.addFunction("unlockMutex", kSig_v_i)
        .addBody([
        // Unlock the mutex.
        kExprLocalGet, 0,   // mutex address
        ...wasmI32Const(0), // 0 => unlocked
        kAtomicPrefix,
        kExprI32AtomicStore, 2, 0,
        // Notify one agent that is waiting on this lock.
        kExprLocalGet, 0,   // mutex address
        ...wasmI32Const(1), // notify 1 waiter
        kAtomicPrefix,
        kExprAtomicNotify, 2, 0,
        kExprDrop])
        .exportFunc();
    // Unsafe non-atomic increment, which must be guarded by a mutex.
    builder.addFunction("increment", kSig_v_i)
        .addBody([
        kExprLocalGet, 0,
        kExprLocalGet, 0,
        kExprI32LoadMem, 2, 0,
        ...wasmI32Const(1),
        kExprI32Add,
        kExprI32StoreMem, 2, 0])
        .exportFunc();
    let moduleBytes = builder.toBuffer();
    let agentCode = `
        $262.agent.receiveBroadcast(function(obj) {
            if (obj === null) {
                return;
            }
            let moduleBytes = obj.moduleBytes;
            let memory = obj.memory;
            let module = new WebAssembly.Module(moduleBytes);
            let instance = new WebAssembly.Instance(module, {env: {imported_mem: memory}});
            for (let i = 0; i < ${NUM_ITERATIONS}; i++) {
                instance.exports.lockMutex(0);
                instance.exports.increment(4);
                instance.exports.unlockMutex(0);
            }
            $262.agent.report('done');
            $262.agent.leaving();
        });
    `;

    let getReport = $262.agent.getReport.bind($262.agent);
    $262.agent.getReport = function() {
        let r;
        while ((r = getReport()) == null) {
            $262.agent.sleep(1);
        }
        return r;
    };
    $262.agent.start(agentCode);
    $262.agent.start(agentCode);
    $262.agent.broadcast({moduleBytes: moduleBytes, memory: memory});

    // wait for agents to finish
    $262.agent.getReport();
    $262.agent.getReport();

    let i32a = new Int32Array(memory.buffer);
    assertEqual(0, i32a[0]);  // mutex unlocked
    assertEqual(2 * NUM_ITERATIONS, i32a[1]); // all increments reflected
})();

(function TestFastMutex() {
    let memory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
    let builder = new WasmModuleBuilder();
    builder.addImportedMemory("env", "imported_mem", 1, 1, "shared");
    builder.addFunction("lockMutex", kSig_v_i)
        .addLocals(kWasmI32, 1)
        .addBody([
            kExprBlock, kWasmVoid,
                kExprLocalGet, 0,
                ...wasmI32Const(0),
                ...wasmI32Const(1),
                kAtomicPrefix,
                kExprI32AtomicCompareExchange, 2, 0,
                kExprLocalSet, 1,
                kExprLocalGet, 1,
                kExprI32Eqz,
                kExprBrIf, 0,
                kExprLoop, kWasmVoid,
                    kExprLocalGet, 1,
                    ...wasmI32Const(2),
                    kExprI32Eq,
                    kExprLocalGet, 0,
                    ...wasmI32Const(1),
                    ...wasmI32Const(2),
                    kAtomicPrefix,
                    kExprI32AtomicCompareExchange, 2, 0,
                    kExprI32Eqz,
                    kExprI32Eqz,
                    kExprI32Ior,
                    kExprIf, kWasmVoid,
                        kExprLocalGet, 0,
                        ...wasmI32Const(2),
                        ...wasmI64Const(-1),
                        kAtomicPrefix,
                        kExprI32AtomicWait, 2, 0,
                        kExprDrop,
                    kExprEnd,
                    kExprLocalGet, 0,
                    ...wasmI32Const(0),
                    ...wasmI32Const(2),
                    kAtomicPrefix,
                    kExprI32AtomicCompareExchange, 2, 0,
                    kExprLocalSet, 1,
                    kExprLocalGet, 1,
                    kExprI32Eqz,
                    kExprI32Eqz,
                    kExprBrIf, 0,
                kExprEnd,
            kExprEnd])
        .exportFunc();
    builder.addFunction("unlockMutex", kSig_v_i)
        .addBody([
            kExprLocalGet, 0,
            ...wasmI32Const(1),
            kAtomicPrefix,
            kExprI32AtomicSub, 2, 0,
            ...wasmI32Const(1),
            kExprI32Eq,
            kExprI32Eqz,
            kExprIf, kWasmVoid,
                kExprLocalGet, 0,
                ...wasmI32Const(0),
                kAtomicPrefix,
                kExprI32AtomicStore, 2, 0,
                kExprLocalGet, 0,
                ...wasmI32Const(1),
                kAtomicPrefix,
                kExprAtomicNotify, 2, 0,
                kExprDrop,
            kExprEnd])
        .exportFunc();
    builder.addFunction("increment", kSig_v_i)
        .addBody([
            kExprLocalGet, 0,
            kExprLocalGet, 0,
            kExprI32LoadMem, 2, 0,
            ...wasmI32Const(1),
            kExprI32Add,
            kExprI32StoreMem, 2, 0])
        .exportFunc();
    let moduleBytes = builder.toBuffer();
    let agentCode = `
        $262.agent.receiveBroadcast(function(obj) {
            if (obj === null) {
                return;
            }
            let moduleBytes = obj.moduleBytes;
            let memory = obj.memory;
            let module = new WebAssembly.Module(moduleBytes);
            let instance = new WebAssembly.Instance(module, {env: {imported_mem: memory}});
            for (let i = 0; i < ${NUM_ITERATIONS}; i++) {
                instance.exports.lockMutex(0);
                instance.exports.increment(4);
                instance.exports.unlockMutex(0);
            }
            $262.agent.report('done');
            $262.agent.leaving();
        });
    `;

    let getReport = $262.agent.getReport.bind($262.agent);
    $262.agent.getReport = function() {
        let r;
        while ((r = getReport()) == null) {
            $262.agent.sleep(1);
        }
        return r;
    };
    $262.agent.start(agentCode);
    $262.agent.start(agentCode);
    $262.agent.broadcast({moduleBytes: moduleBytes, memory: memory});

    // wait for agents to finish
    $262.agent.getReport();
    $262.agent.getReport();

    let i32a = new Int32Array(memory.buffer);
    assertEqual(0, i32a[0]);
    assertEqual(2 * NUM_ITERATIONS, i32a[1]);
})();

(function TestAtomicIncrement() {
    let memory = new WebAssembly.Memory({
        initial: 1, maximum: 1, shared: true});
    let builder = new WasmModuleBuilder();
    builder.addImportedMemory("env", "imported_mem", 1, 1, "shared");
    builder.addFunction("increment", kSig_i_ii)
        .addBody([
        kExprLocalGet, 0,
        kExprLocalGet, 1,
        kAtomicPrefix,
        kExprI32AtomicAdd, 2, 0])
        .exportFunc();
    let moduleBytes = builder.toBuffer();
    let agentCode = `
        $262.agent.receiveBroadcast(function(obj) {
            if (obj === null) {	
                return;	
            }
            let moduleBytes = obj.moduleBytes;
            let memory = obj.memory;
            let module = new WebAssembly.Module(moduleBytes);
            let instance = new WebAssembly.Instance(module, {env: {imported_mem: memory}});
            for (let i = 0; i < ${NUM_ITERATIONS}; i++) {
                instance.exports.increment(0, 1);
            }
            $262.agent.report('done');
            $262.agent.leaving();
        });
    `;

    let getReport = $262.agent.getReport.bind($262.agent);
    $262.agent.getReport = function() {
        let r;
        while ((r = getReport()) == null) {
            $262.agent.sleep(1);
        }
        return r;
    };
    $262.agent.start(agentCode);
    $262.agent.start(agentCode);
    $262.agent.broadcast({moduleBytes: moduleBytes, memory: memory});

    // wait for agents to finish
    $262.agent.getReport();
    $262.agent.getReport();

    let i32a = new Int32Array(memory.buffer);
    assertEqual(2 * NUM_ITERATIONS, i32a[0]);
})();

(function TestAtomicWaitNotify() {
    let memory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
    let builder = new WasmModuleBuilder();
    builder.addImportedMemory("env", "imported_mem", 1, 1, "shared");
    builder.addFunction("notify", kSig_i_ii)
        .addBody([
            kExprLocalGet, 0,
            kExprLocalGet, 1,
            kAtomicPrefix,
            kExprAtomicNotify, 2, 0])
        .exportFunc();
    builder.addFunction("wait32", makeSig([kWasmI32, kWasmI32, kWasmI64], [kWasmI32]))
        .addBody([
            kExprLocalGet, 0,
            kExprLocalGet, 1,
            kExprLocalGet, 2,
            kAtomicPrefix,
            kExprI32AtomicWait, 2, 0])
        .exportFunc();
    builder.addFunction("wait64", makeSig([kWasmI32, kWasmI64, kWasmI64], [kWasmI32]))
        .addBody([
            kExprLocalGet, 0,
            kExprLocalGet, 1,
            kExprLocalGet, 2,
            kAtomicPrefix,
            kExprI64AtomicWait, 3, 0])
        .exportFunc();
    let moduleBytes = builder.toBuffer();
    let module = new WebAssembly.Module(moduleBytes);
    let instance = new WebAssembly.Instance(module, {env: {imported_mem: memory}});

    assertEqual(0, instance.exports.notify(0, 4));
    assertEqual(2, instance.exports.wait32(0, 0, BigInt(1e9)));
    assertEqual(2, instance.exports.wait64(0, BigInt(0), BigInt(1e9)));
})();

(function TestMemoryGrow() {
    let memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true});
    let builder = new WasmModuleBuilder();
    builder.addImportedMemory("env", "imported_mem", 1, 2, "shared");
    builder.addFunction("grow", kSig_i_i)
        .addBody([
        kExprLocalGet, 0,
        kExprMemoryGrow, kMemoryZero])
        .exportFunc();
    let moduleBytes = builder.toBuffer();
    let module = new WebAssembly.Module(moduleBytes);
    let instance = new WebAssembly.Instance(module, {env: {imported_mem: memory}});

    assertEqual(1, instance.exports.grow(1));
    assertThrows(() => memory.grow(1), RangeError);
})();

(function TestByteLength() {
    // make sure shared memories are backed by a direct ByteBuffer
    let memory = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
    assertEqual(kPageSize, memory.buffer.byteLength);
})();