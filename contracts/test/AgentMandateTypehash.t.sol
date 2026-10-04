// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Container agents, phase 0 (experimental): the four EIP-712 types a circuit's holder signs (Mandate, TaskOffer,
// TaskVerdict, MandateRevocation), computed a third time in Solidity from spec/vectors/container-agent.json. The JS SDK
// and spec/vectors/verify.py compute them too; all three must agree. Pure computation: no contract reads these types and
// none is changed. Scope[] hashes as keccak256 of the concatenated item hashes, bytes32[] as keccak256 of the packed
// elements, an empty array as keccak256("").
// 容器代理阶段 0：持有人签的四个 EIP-712 类型，在 Solidity 里第三次计算（取自 spec/vectors/container-agent.json），与 JS、Python 三方一致。纯计算，不改任何合约。

import "forge-std/Test.sol";

contract AgentMandateTypehashTest is Test {
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant SCOPE_TYPEHASH = keccak256("Scope(address provider,address token,uint256 cap)");
    bytes32 constant MANDATE_TYPEHASH = keccak256("Mandate(address principal,address agent,address agentKey,uint8 mode,bytes32 taskHash,Scope[] scope,address feeToken,uint256 feeCap,uint64 notBefore,uint64 expires,uint256 nonce,bool subdelegate)Scope(address provider,address token,uint256 cap)");
    bytes32 constant TASK_OFFER_TYPEHASH = keccak256("TaskOffer(address principal,address agent,bytes32 taskHash,uint8 mode,address feeToken,uint256 fee,uint64 deadline,uint64 exp,uint256 nonce)");
    bytes32 constant TASK_VERDICT_TYPEHASH = keccak256("TaskVerdict(bytes32 mandateHash,bytes32 deliverableHash,uint8 verdict,bytes32 reasonHash,uint64 issued)");
    bytes32 constant MANDATE_REVOCATION_TYPEHASH = keccak256("MandateRevocation(address principal,bytes32[] mandateHashes,uint64 revokedBefore,uint64 issued)");
    address constant HUB = 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee;
    address constant PRINCIPAL = 0x86DDaEF00401E3F10418398D67D7189fc458eA95;
    address constant AGENT = 0x19366C3c69fFEb3b286D9Fa6cC5E616375baAFd3;
    address constant AGENT_KEY = 0xAe72A48c1a36bd18Af168541c53037965d26e4A8;
    bytes32 constant TASK_HASH = 0x7cd6a489238bf6b1b71d7136181de5b847fee4b200fc3a8d6532f4915dcf7ff0;

    function domain(uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("TapeAPI"), keccak256("1"), chainId, HUB));
    }

    function digest(bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain(56), structHash));
    }

    function mandateHash(bytes32 scopeArrayHash, uint8 mode, address feeToken, uint256 feeCap, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            MANDATE_TYPEHASH, PRINCIPAL, AGENT, AGENT_KEY, mode, TASK_HASH, scopeArrayHash, feeToken, feeCap,
            uint64(1789000000), uint64(1789086400), nonce, false
        ));
    }

    function test_typehashesMatchTheVector() public pure {
        assertEq(SCOPE_TYPEHASH, bytes32(0xb16bb4dde6f01fa8f71521aeabb4ce63a0c9c7554fc6e9953718f9ee96191fbb));
        assertEq(MANDATE_TYPEHASH, bytes32(0xf2121b841c65f4d74c6cd4a5f8de39d1aaec1060d147338e7a635ecc5bca8171));
        assertEq(TASK_OFFER_TYPEHASH, bytes32(0x9a96ccf2dd5736d1b56c02a80e91f86d6d8b5008b4abe68fee9cc78915e09546));
        assertEq(TASK_VERDICT_TYPEHASH, bytes32(0xdfd34037554f981271bc0b592c8389130df249ee45feb1a47f3706be5e8e33aa));
        assertEq(MANDATE_REVOCATION_TYPEHASH, bytes32(0xc2b443beeff2d29c4d489bbcc169a8ef6642edd24320e8dd612d50c5c2152ff3));
    }

    function test_mandateWithTwoScopeItems() public pure {
        bytes32 s0 = keccak256(abi.encode(SCOPE_TYPEHASH, 0x00000000000000000000000000000000000005e1, 0x0000000000000000000000000000000000000000, uint256(0)));
        bytes32 s1 = keccak256(abi.encode(SCOPE_TYPEHASH, 0x00000000000000000000000000000000000005e2, 0x0000000000000000000000000000000000000000, uint256(0)));
        assertEq(s0, bytes32(0xf3386688fada3a897b773e2432a2d9eb096e9a8fedf75b2d32e4e60068c7995f));
        assertEq(s1, bytes32(0x2e7077b88f8cf5e85f3e3faaa93c13bc1bc7f9d476aa122bcf6cd416531faec7));
        bytes32 sh = mandateHash(keccak256(abi.encodePacked(s0, s1)), 0, 0x0000000000000000000000000000000000000000, 0, 1);
        assertEq(sh, bytes32(0x95d93105029fb7124b3be259d91c6f1dd4c44ad4f7e94258cf042215efc50efb));
        bytes32 d = digest(sh);
        assertEq(d, bytes32(0x35eb4e7a6b9350682344107fac505300358ae1a1ab561c982f23f0c3844c223a));
        // the holder's signature from the vector recovers to the holder / 向量里的持有人签名恢复为持有人
        assertEq(ecrecover(d, 28, bytes32(0x69ff0d1e14fe3df990c5c8c80bc4e059f34104350a54c5d571ad8e099ee83050), bytes32(0x3d130c932d4c65ccb9d05c13193e258747fbbaa085b03f1127d051b224bc940c)), 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A);
    }

    function test_mandateWithAnEmptyScope() public pure {
        bytes32 sh = mandateHash(keccak256(""), 0, 0x0000000000000000000000000000000000000000, 0, 1);
        assertEq(sh, bytes32(0xbaaee73d97270a86e85ee71697e0cb787825cf168d737bd4c8f0da08445cbef7));
        assertEq(digest(sh), bytes32(0xd281706a18bd563a691f86b6dc508ae0e63f56a9ca9e740493e81f9388cc2fcf));
    }

    function test_theChainIsInTheDomain() public pure {
        assertEq(keccak256(abi.encodePacked("\x19\x01", domain(196), bytes32(0x95d93105029fb7124b3be259d91c6f1dd4c44ad4f7e94258cf042215efc50efb))), bytes32(0x8949a6cb8c03096a1b4f993212e90ac3f3523852ad6e69540c4f23c79d20fa32));
    }

    function test_offerVerdictAndRevocation() public pure {
        bytes32 offer = keccak256(abi.encode(
            TASK_OFFER_TYPEHASH, PRINCIPAL, AGENT, TASK_HASH, uint8(0), 0x0000000000000000000000000000000000000000, uint256(0), uint64(1789086400), uint64(1789003600), uint256(1)
        ));
        assertEq(digest(offer), bytes32(0x81a04adea0ea7cf95587504002a3de06720ef082681c468fef256e786f224c69));
        bytes32 verdict = keccak256(abi.encode(
            TASK_VERDICT_TYPEHASH, bytes32(0x35eb4e7a6b9350682344107fac505300358ae1a1ab561c982f23f0c3844c223a), bytes32(0xed085fb3552293440e34830fd3c72c8c3b2955b331f78222bfdba9cc3354fea6), uint8(2), bytes32(0xbea1917440cb8affa0f771ffab8d07019359b3664986427b8804c419036ce188), uint64(1789050000)
        ));
        assertEq(digest(verdict), bytes32(0x29aa83b6348af0170393510cecd7315373ad20ca85d6c6f11431b66e65ed60c7));
        bytes32 list = keccak256(abi.encodePacked(bytes32(0x35eb4e7a6b9350682344107fac505300358ae1a1ab561c982f23f0c3844c223a), bytes32(0xd281706a18bd563a691f86b6dc508ae0e63f56a9ca9e740493e81f9388cc2fcf)));
        bytes32 revocation = keccak256(abi.encode(MANDATE_REVOCATION_TYPEHASH, PRINCIPAL, list, uint64(0), uint64(1789060000)));
        assertEq(digest(revocation), bytes32(0x71a0bff57b40271e4d1a0b1468870d98ea70ead62567c9961038965e76d3a7dc));
    }

    /// No agent type shares a typehash with the other types of the hub domain / 与同域的其它类型永不同类型哈希
    function test_distinctFromTheOtherHubTypes() public pure {
        bytes32[4] memory others = [
            keccak256("Delegation(address container,address signer,uint64 expires)"),
            keccak256("ChannelKeys(address container,bytes32 x25519,bytes32 ed25519,bytes32 inbox,uint64 issued,uint64 expires)"),
            keccak256("ManifestContent(address container,bytes32 contentHash)"),
            keccak256("Voucher(address consumer,address provider,uint256 cumulative,uint64 expires)")
        ];
        bytes32[5] memory mine = [SCOPE_TYPEHASH, MANDATE_TYPEHASH, TASK_OFFER_TYPEHASH, TASK_VERDICT_TYPEHASH, MANDATE_REVOCATION_TYPEHASH];
        for (uint256 i = 0; i < mine.length; i++) {
            for (uint256 j = 0; j < others.length; j++) assertTrue(mine[i] != others[j]);
            for (uint256 j = i + 1; j < mine.length; j++) assertTrue(mine[i] != mine[j]);
        }
    }
}
