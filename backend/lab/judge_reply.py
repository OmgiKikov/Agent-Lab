"""The judge's model reply, validated once before evidence is interpreted."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class RuleReply(BaseModel):
    model_config = ConfigDict(strict=True)

    rule_id: str = Field(alias='ruleId')
    status: Literal['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE']
    reason: NonEmptyText
    agent_quote: str = Field(alias='agentQuote')
    title: str = ''

    @model_validator(mode='after')
    def measured_quote(self) -> Self:
        if self.status in ('PASS', 'FAIL') and not self.agent_quote.strip():
            raise ValueError('measured verdict needs a quote')
        return self


class JudgeReply(BaseModel):
    model_config = ConfigDict(strict=True)

    rules: list[RuleReply]
    customer_goal: NonEmptyText | None = Field(default=None, alias='customerGoal')
