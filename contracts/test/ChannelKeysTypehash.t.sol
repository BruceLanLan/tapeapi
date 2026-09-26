// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TAP-26 §3.1: the ChannelKeys EIP-712 authorisation, computed a second time in Solidity from spec/vectors/
// tap-26-identity.json. The JS SDK and the Python verifier compute it too; all three must agree. `inbox` is
// keccak256(canonicalJSON({ relays, bus? })), so the holder's signature covers where invites go.
// 在 Solidity 里再算一遍 ChannelKeys 授权摘要（取自 spec/vectors/tap-26-identity.json），与 JS、Python 三方一致。

import "forge-std/Test.sol";

contract ChannelKeysTypehashTest is Test {
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant CHANNEL_KEYS_TYPEHASH = keccak256("ChannelKeys(address container,bytes32 x25519,bytes32 ed25519,bytes32 inbox,uint64 issued,uint64 expires)");
    bytes32 constant DELEGATION_TYPEHASH = keccak256("Delegation(address container,address signer,uint64 expires)");

    function test_digestAndSignerMatchTheVector() public pure {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("TapeAPI"), keccak256("1"), uint256(56), 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee));
        bytes32 structHash = keccak256(abi.encode(
            CHANNEL_KEYS_TYPEHASH, 0x86DDaEF00401E3F10418398D67D7189fc458eA95,
            bytes32(0xad438bfae31f6c093d61d4339255ea798092c9fadd07b97827f4b0ae9dee7c1c), bytes32(0x66f975e51bd242b7d52b0744c933af11734a4a5888054cc13485b822ca7427ad), bytes32(0xf54cf8fea5e5289180ab0b8fcab54420ccb29fcc08cc56c3d6d2696225622468), uint64(1789000000), uint64(1790000000)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        assertEq(digest, bytes32(0x6776fe8f164d2239e64bfdea5f126239c3a1ebbaa62ec24a3cca90f4eed82c3a));
        address signer = ecrecover(digest, 28, bytes32(0x6b598cd1937c5e09f0cdc9ffea85f5852273276dc08050f9d1ef8b8b70887463), bytes32(0x700d83cb9843f762c6e5ced4476ba855f79f330c32cb9be4acd8e8d39b755e09));
        assertEq(signer, 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A);
    }

    /// A TAP-20 service delegation and a channel authorisation can never share a digest / 服务委托与通道授权永不同摘要
    function test_distinctFromDelegation() public pure {
        assertTrue(CHANNEL_KEYS_TYPEHASH != DELEGATION_TYPEHASH);
    }
}
