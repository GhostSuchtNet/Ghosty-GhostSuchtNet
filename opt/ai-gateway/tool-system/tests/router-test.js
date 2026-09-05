"use strict";

const {
    routeRequest
} = require("../index");

async function main() {
    const result = await routeRequest(
        {
            text: 'Berechne SHA-256 von "Hallo"',
            model: "auto"
        },
        {
            isToolAllowed: () => true,
            allowedModels: new Set([
                "ghosty-lite",
                "ghosty-medium"
            ]),
            abortSignal: null,
            logger: console
        }
    );

    console.dir(result, {
        depth: null
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
