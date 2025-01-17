#include "../pedersen_hash/pedersen.hpp"
#include "barretenberg/common/serialize.hpp"
#include "c_bind.hpp"
#include "pedersen.hpp"

extern "C" {

using namespace barretenberg;

WASM_EXPORT void pedersen___init() {}

WASM_EXPORT void pedersen___compress_fields(fr::in_buf left, fr::in_buf right, fr::out_buf result)
{
    auto lhs = barretenberg::fr::serialize_from_buffer(left);
    auto rhs = barretenberg::fr::serialize_from_buffer(right);
    auto r = crypto::pedersen_hash::hash({ lhs, rhs });
    barretenberg::fr::serialize_to_buffer(r, result);
}

WASM_EXPORT void pedersen___plookup_compress_fields(fr::in_buf left, fr::in_buf right, fr::out_buf result)
{
    pedersen___compress_fields(left, right, result);
}
WASM_EXPORT void pedersen___compress(fr::vec_in_buf inputs_buffer, fr::out_buf output)
{
    std::vector<grumpkin::fq> to_compress;
    read(inputs_buffer, to_compress);
    auto r = crypto::pedersen_hash::hash(to_compress);
    barretenberg::fr::serialize_to_buffer(r, output);
}

WASM_EXPORT void pedersen___plookup_compress(fr::vec_in_buf inputs_buffer, fr::out_buf output)
{
    pedersen___compress(inputs_buffer, output);
}

WASM_EXPORT void pedersen___compress_with_hash_index(fr::vec_in_buf inputs_buffer,
                                                     uint32_t const* hash_index,
                                                     fr::out_buf output)
{
    std::vector<grumpkin::fq> to_compress;
    read(inputs_buffer, to_compress);
    const size_t generator_offset = ntohl(*hash_index);
    crypto::GeneratorContext<curve::Grumpkin> ctx; // todo fix
    ctx.offset = generator_offset;
    auto r = crypto::pedersen_hash::hash(to_compress, ctx);
    barretenberg::fr::serialize_to_buffer(r, output);
}

WASM_EXPORT void pedersen___commit(fr::vec_in_buf inputs_buffer, fr::out_buf output)
{
    std::vector<grumpkin::fq> to_compress;
    read(inputs_buffer, to_compress);
    grumpkin::g1::affine_element pedersen_hash = crypto::pedersen_commitment::commit_native(to_compress);

    serialize::write(output, pedersen_hash);
}
WASM_EXPORT void pedersen___plookup_commit(fr::vec_in_buf inputs_buffer, fr::out_buf output)
{
    pedersen___commit(inputs_buffer, output);
}

WASM_EXPORT void pedersen___plookup_commit_with_hash_index(fr::vec_in_buf inputs_buffer,
                                                           uint32_t const* hash_index,
                                                           fr::out_buf output)
{
    std::vector<grumpkin::fq> to_compress;
    read(inputs_buffer, to_compress);
    const size_t generator_offset = ntohl(*hash_index);
    crypto::GeneratorContext<curve::Grumpkin> ctx;
    ctx.offset = generator_offset;
    auto commitment = crypto::pedersen_commitment::commit_native(to_compress, ctx);
    serialize::write(output, commitment);
}

WASM_EXPORT void pedersen___buffer_to_field(uint8_t const* data, fr::out_buf r)
{
    std::vector<uint8_t> to_compress;
    read(data, to_compress);
    auto output = crypto::pedersen_hash::hash_buffer(to_compress);
    write(r, output);
}
}