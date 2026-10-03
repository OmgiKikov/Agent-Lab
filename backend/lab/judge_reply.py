"""The judge's model reply, validated once before evidence is interpreted."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints, model_validator

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
# Models send null, or leave the field out, where they have nothing to say: that is no text.
NoneAsEmpty = BeforeValidator(lambda value: '' if value is None else value)


class RuleReply(BaseModel):
    model_config = ConfigDict(strict=True)

    rule_id: str = Field(alias='ruleId')
    status: Literal['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE']
    reason: Annotated[str, NoneAsEmpty, StringConstraints(strip_whitespace=True)] = ''
    agent_quote: Annotated[str, NoneAsEmpty] = Field(default='', alias='agentQuote')
    # A criterion without a failure pattern has no title.
    title: Annotated[str, NoneAsEmpty] = ''

    @model_validator(mode='after')
    def measured_evidence(self) -> Self:
        """PASS and FAIL stand on a reason and a quote. A criterion that was not measured has neither to give, and one
        such row must not cost the verdicts in the rest of the reply."""
        if self.status in ('PASS', 'FAIL') and not (self.reason and self.agent_quote.strip()):
            raise ValueError('measured verdict needs a reason and a quote')
        return self


class JudgeReply(BaseModel):
    model_config = ConfigDict(strict=True)

    rules: list[RuleReply]
    customer_goal: NonEmptyText | None = Field(default=None, alias='customerGoal')
