#!/usr/bin/env python3

import json
import sys

from pint import UnitRegistry

ureg = UnitRegistry(autoconvert_offset_to_baseunit=True)


def fail(message):
    print(json.dumps({
        "ok": False,
        "error": str(message)
    }, ensure_ascii=False))
    sys.exit(1)


try:
    payload = json.load(sys.stdin)

    value = payload["value"]
    source = str(payload["from"])
    target = str(payload["to"])

    quantity = float(value) * ureg(source)
    result = quantity.to(target)

    print(json.dumps({
        "ok": True,
        "value": result.magnitude,
        "unit": str(result.units)
    }, ensure_ascii=False))

except Exception as exc:
    fail(exc)
