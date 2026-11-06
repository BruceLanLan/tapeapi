// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Policy circuits (3.0, EXPERIMENTAL; @tapeapi/policy-circuit, after the Policy Circuit Gate TAP draft, TAPs pull request
// #84, a draft PR, not merged; head 0b73174): the two EIP-712 types a principal signs (PolicyBinding, PolicyBindingRevocation) in TAP-11's domain
// "TapeAPI" on the hub, computed a third time in Solidity from policy-circuit/test/vectors/vectors.json (the package's
// pinned copy of the draft's vectors; the constants below were printed from that file, not typed). The JS package and
// spec/vectors/verify.py compute them too; all three must agree. Pure computation: no contract reads these types and
// none is changed. bytes32[] hashes as keccak256 of the packed elements (an empty one: keccak256("")).
// 策略电路（3.0，实验性；TAPs #84 草稿，未合并）：两个 EIP-712 类型在 Solidity 里第三次计算（取自本包钉住的草稿向量副本，常量由脚本从
// 该文件打印），与 JS、Python 三方一致。纯计算，不改任何合约。

import "forge-std/Test.sol";

contract PolicyBindingTypehashTest is Test {
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant POLICY_BINDING_TYPEHASH = keccak256("PolicyBinding(bytes32 netlistHash,uint8 subjectKind,bytes32 subject,bytes32 tablesHash,uint64 notBefore,uint64 expires,uint64 issued)");
    bytes32 constant POLICY_REVOCATION_TYPEHASH = keccak256("PolicyBindingRevocation(bytes32[] bindingHashes,uint64 revokedBefore,uint64 issued)");
    address constant HUB = 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee;
    // test key 1 of the draft (an address only; the draft's public test key is not repeated here) / 草稿测试钥匙 1 的地址
    address constant HOLDER = 0x7B9cbc6dFD675433e094499cF07213178f509DD6;

    function domain(uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("TapeAPI"), keccak256("1"), chainId, HUB));
    }

    function bindingStruct() internal pure returns (bytes32) {
        return keccak256(abi.encode(
            POLICY_BINDING_TYPEHASH,
            bytes32(0x5e2d00e35e7e9a7a521027164a037fead6bbed69ef1ef5816c1b9de07f6cd8c6),
            uint8(1),
            bytes32(0xba89d2c77e2091ab4b5c994a99611b5876b93b829ac52173ecb065d67f7627d2),
            bytes32(0xef34c7aa556c6ae186d393617d6550e8dd038d258ea785dba1745ee10fb29083),
            uint64(1793008800), uint64(1793613600), uint64(1793005200)
        ));
    }

    function test_typehashesAndDomainMatchTheVector() public pure {
        assertEq(POLICY_BINDING_TYPEHASH, bytes32(0x9965afb004b518a9dc796972c26561bf05b7a2ed59a730e38276c10dd8b0a468));
        assertEq(POLICY_REVOCATION_TYPEHASH, bytes32(0x59612c001eea9fe0adaf57e3ba597d8896c9bdea0c6d95e1e6f081e9e521f8f9));
        assertEq(domain(56), bytes32(0xa73ee348b5672f12dbc174f66a7d162c69e0d64befdba88475d9d7e3c0fd3ac7));
        assertEq(domain(97), bytes32(0x54a1ceeb8ab3a26a00c8c3c97ab3caa063dfe1cc9cb142481e730ad02afe2f02));
        assertEq(domain(31337), bytes32(0xd9262f282babec0043f82c44bab1ef8034bafdf6d706f1e6bdc420d8d94c6677));
    }

    function test_mandateBinding() public pure {
        bytes32 sh = bindingStruct();
        assertEq(sh, bytes32(0xe778c6d6450f5bdd81cbc7b5902c063fa3931578bc33c0519d8fd4c8f59b2180));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", domain(56), sh));
        assertEq(d, bytes32(0x342cb1a5d7bc85e13fdda937c05c370a5639212f978c2ceb03a09e29a1b4cbd8));
        // another chain, another binding hash / 另一条链，另一个绑定哈希
        assertEq(keccak256(abi.encodePacked("\x19\x01", domain(97), sh)), bytes32(0x97b1a133fcf600552884936d09aed65b8a3b52cad2959d2b789b16454d2ccf7e));
        // the holder's signature from the vector recovers to the holder / 向量里的持有人签名恢复为持有人
        assertEq(ecrecover(d, 27, bytes32(0xb26a2e4e28bd5dbef5bbf4635ec59dadd396cbab93f3cf0d0588481e86480fd4), bytes32(0x73c93dc17c936fa1d4c995dee4fb7b81ea4d345eb8c85bb0fba2b5ab3341aed7)), HOLDER);
    }

    function test_revocationByHash() public pure {
        bytes32 listed = keccak256(abi.encodePacked(bytes32(0x342cb1a5d7bc85e13fdda937c05c370a5639212f978c2ceb03a09e29a1b4cbd8)));
        bytes32 sh = keccak256(abi.encode(POLICY_REVOCATION_TYPEHASH, listed, uint64(0), uint64(1793095200)));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", domain(56), sh));
        assertEq(d, bytes32(0xb93358173a224f311309cfc2a14bcb2090e7983a85899ccb62dc89b579a26a82));
        assertEq(ecrecover(d, 27, bytes32(0x6caad3469d370214dfbd617fa482893ab2dfb406dcc78416bf5bb1f21f5a13bb), bytes32(0x57b5999ecb5332a6abf0af79a4888796334c72be507b96db8672b69169aaa94c)), HOLDER);
    }

    function test_revocationWithNoHashes() public pure {
        bytes32 sh = keccak256(abi.encode(POLICY_REVOCATION_TYPEHASH, keccak256(""), uint64(0), uint64(1793095200)));
        assertEq(keccak256(abi.encodePacked("\x19\x01", domain(56), sh)), bytes32(0xa190969fb1905a928466e0ca0797dd0bc61ded95aee67097336b11970fe30579));
    }
}
