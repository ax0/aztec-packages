#include "deposit.hpp"
#include "contract.hpp"
#include <aztec3/circuits/apps/private_state_note.hpp>
#include <aztec3/circuits/abis/private_circuit_public_inputs.hpp>
// #include <aztec3/circuits/abis/call_context.hpp>

namespace aztec3::circuits::apps::test_apps::escrow {

using aztec3::circuits::abis::PrivateCircuitPublicInputs;

void withdraw_failure_callback(Composer& composer,
                               OracleWrapper& oracle,
                               NT::fr const& _asset_id,
                               NT::fr const& _amount,
                               NT::address const& _owner_address,
                               NT::fr const& _memo)
{
    CT::fr asset_id = to_ct(composer, _asset_id);
    CT::fr amount = to_ct(composer, _amount);
    CT::address owner_address = to_ct(composer, _owner_address);
    CT::fr memo = to_ct(composer, _memo);

    CT::address msg_sender = oracle.get_msg_sender();

    auto contract = init(composer, oracle);

    auto& balances = contract.get_private_state("balances");

    balances.at({ owner_address.to_field(), asset_id })
        .add({
            .value = amount,
            .owner_address = owner_address,
            .creator_address = msg_sender,
            .memo = memo,
        });

    contract.finalise();

    // TODO: maybe pass `oracle` to this `create()` function as well?
    auto public_inputs = PrivateCircuitPublicInputs<CT>::create();

    public_inputs.call_context = oracle.get_call_context(); /// TODO: can this be abstracted away out of this body?

    public_inputs.custom_public_inputs[0] = asset_id;
    public_inputs.custom_public_inputs[1] = amount;
    public_inputs.custom_public_inputs[2] = owner_address.to_field();
    public_inputs.custom_public_inputs[3] = memo;

    public_inputs.set_commitments(contract.private_state_factory.commitments);
    public_inputs.set_nullifiers(contract.private_state_factory.nullifiers);

    public_inputs.pay_fee_from_l1 = to_ct(composer, true);
    CT::fr(*public_inputs.pay_fee_from_l1)
        .assert_equal(1); /// TODO: Ugly way of hard-coding a witness. Is there a nicer way?

    public_inputs.set_public(composer);

    info("public inputs: ", public_inputs);
};

} // namespace aztec3::circuits::apps::test_apps::escrow