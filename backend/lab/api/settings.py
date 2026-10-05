"""The section «Настройки»: whether the models the Lab asks answer."""

import asyncio

from fastapi import APIRouter

from .. import models

router = APIRouter()


@router.post('/api/models/check')
async def check_models() -> dict:
    main, endpoint = models.endpoints().main, models.second_judge()
    if endpoint is None:
        return {'main': await models.check(main), 'second': None}
    main, second = await asyncio.gather(models.check(main), models.check(endpoint))
    return {'main': main, 'second': second}
