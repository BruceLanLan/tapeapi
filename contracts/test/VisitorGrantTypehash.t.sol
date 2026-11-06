// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Visitor grants (INTERNAL, EXPERIMENTAL prototype of interop phase I1; not a TAP, no service knows it): the two EIP-712
// types a visitor's wallet signs (VisitorGrant, GrantRevocation) in their own domain "TapeAPI Visitor Grant", computed a
// third time in Solidity from spec/vectors/interop-visitor-grant.json. The JS SDK (@tapeapi/sdk/interop) and
// spec/vectors/verify.py compute them too; all three must agree. Pure computation: no contract reads these types and none
// is changed. string hashes as keccak256 of its UTF-8, string[] as keccak256 of the concatenated element hashes,
// bytes32[] as keccak256 of the packed elements (an empty one: keccak256("")).
// 访客授权（内部、实验性原型，不是 TAP）：两个 EIP-712 类型在 Solidity 里第三次计算，与 JS、Python 三方一致。纯计算，不改任何合约。

import "forge-std/Test.sol";

contract VisitorGrantTypehashTest is Test {
    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant VISITOR_GRANT_TYPEHASH = keccak256("VisitorGrant(string statement,address user,address caller,string callerName,address callerHolder,address callerKey,address audience,string audienceName,address audienceHolder,string[] methods,uint32 maxCalls,uint64 notBefore,uint64 expires,bytes32 nonce)");
    bytes32 constant GRANT_REVOCATION_TYPEHASH = keccak256("GrantRevocation(address user,bytes32[] grantHashes,uint64 revokedBefore,uint64 issued)");
    address constant HUB = 0xe61A9C7213a6Aa616C246a2B569e555B417b25ee;
    address constant USER = 0x6cEEE2D764EE8BdeE737e53e5F02a8275AFe0456;

    function domain(uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("TapeAPI Visitor Grant"), keccak256("1"), chainId, HUB));
    }

    function test_typehashesAndDomainMatchTheVector() public pure {
        assertEq(VISITOR_GRANT_TYPEHASH, bytes32(0xbc95bd5b4977cb089511e2e459636a0c22d7d0d29280f72043963456ac3e8f0e));
        assertEq(GRANT_REVOCATION_TYPEHASH, bytes32(0x065cffa2962afb3c14827c4d10da27f7f6992c32837f9748a7046963335f03f5));
        assertEq(domain(56), bytes32(0xdbd05ddb38a6097675b1f87bde7ad79201d08085045992096a6f8a2f72b07d80));
        // its own domain: not TAP-11's "TapeAPI" domain on the same hub / 独立域
        assertTrue(domain(56) != keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("TapeAPI"), keccak256("1"), uint256(56), HUB)));
    }

    function test_grantOneMethod() public pure {
        bytes32 methodsHash = keccak256(abi.encodePacked(keccak256("history")));
        assertEq(methodsHash, bytes32(0x08184b04f84d1d5103cc4fddca18010c3d437fa72c5efe181c56381f299fe77f));
        // two halves (every member is one static word, so the concatenation is abi.encode of all 15; one call is too deep
        // for the stack) / 分两半编码（每个成员一个字，拼接即整体编码；一次编码栈太深）
        bytes memory head = abi.encode(
            VISITOR_GRANT_TYPEHASH,
            keccak256("Allow 12.7.tape to call these methods of 13.7.tape on my behalf: history. At most 100 calls, valid from 2026-10-03 04:00:00 to 2026-10-03 05:00:00 UTC. This grant includes no payment. Revocable at any time with 13.7.tape."),
            USER, 0xa6a6A6a6a6a6A6A6A6a6A6a6a6a6a6a6a6a6a6A6, keccak256("12.7.tape"), 0x4444444444444444444444444444444444444444,
            0x504e4FbaB7bC2962b361E3730B965E61F289d0cC, 0x5e5E5e5e5E5e5E5E5e5E5E5e5e5E5E5E5e5E5E5e
        );
        bytes memory tail = abi.encode(
            keccak256("13.7.tape"), 0x6666666666666666666666666666666666666666, methodsHash, uint32(100), uint64(1791000000),
            uint64(1791003600), bytes32(0x0101010101010101010101010101010101010101010101010101010101010101)
        );
        bytes32 sh = keccak256(bytes.concat(head, tail));
        assertEq(sh, bytes32(0xc5ad6c2f9a7dde9b323668c30c90b141fd932a56a4698ea72c6bf6e246af8334));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", domain(56), sh));
        assertEq(d, bytes32(0xb33a51914cd294d4313c6e296db5680bd7e95292d81062c63f252eb49980fa47));
        // the visitor's signature from the vector recovers to the visitor / 向量里的访客签名恢复为访客
        assertEq(ecrecover(d, 28, bytes32(0x0719deaacbd5f7f701dbd192e0e5e5877e2129190cbc7a631566bdf73083680e), bytes32(0x3583c22eeda3aa9f0762b0ba93429e379dd2b056d9f41c39b0a761bd93110ae1)), USER);
    }

    function test_revocationByDate() public pure {
        bytes32 sh = keccak256(abi.encode(GRANT_REVOCATION_TYPEHASH, USER, keccak256(""), uint64(1791000000), uint64(1791000060)));
        assertEq(sh, bytes32(0x3624f6a9288d37bfbc45697333bab91c0988fb735abcc32f09889c97ebcd511c));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", domain(56), sh));
        assertEq(d, bytes32(0xb7f06eeeb9b682c82ec42e8b7381cb5e9bdcd9154e04a4802b0b752cc7a098a7));
        assertEq(ecrecover(d, 27, bytes32(0xf9f44957138b0aa4faaaafcf42d1d727dce01673483bccd867f72126b5000f0c), bytes32(0x61f5adbd28b051960fd7973d68588a994b7861fd38c0204c1ec4eb7ef0d4bd7d)), USER);
    }
}
