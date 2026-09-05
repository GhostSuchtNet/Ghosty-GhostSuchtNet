"use strict";

class Semaphore {
    constructor(limit) {
        this.limit = Math.max(1, Number(limit) || 1);
        this.active = 0;
        this.waiting = [];
    }

    async acquire(signal) {
        if (signal?.aborted) {
            throw Object.assign(
                new Error("Anfrage abgebrochen."),
                { name: "AbortError" }
            );
        }

        if (this.active < this.limit) {
            this.active += 1;
            return;
        }

        await new Promise((resolve, reject) => {
            const item = { resolve, reject };

            const abort = () => {
                const index = this.waiting.indexOf(item);
                if (index >= 0) this.waiting.splice(index, 1);

                reject(Object.assign(
                    new Error("Anfrage abgebrochen."),
                    { name: "AbortError" }
                ));
            };

            item.abort = abort;
            item.signal = signal;

            if (signal) {
                signal.addEventListener("abort", abort, { once: true });
            }

            this.waiting.push(item);
        });

        this.active += 1;
    }

    release() {
        this.active = Math.max(0, this.active - 1);

        const next = this.waiting.shift();

        if (next) {
            if (next.signal && next.abort) {
                next.signal.removeEventListener("abort", next.abort);
            }

            next.resolve();
        }
    }

    async run(fn, signal) {
        await this.acquire(signal);

        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    state() {
        return {
            limit: this.limit,
            active: this.active,
            waiting: this.waiting.length
        };
    }
}

const resources = {
    light: new Semaphore(8),
    python: new Semaphore(2),
    knowledge: new Semaphore(4),

    office: new Semaphore(1),
    media: new Semaphore(1),
    code: new Semaphore(1)
};

async function runResource(resource, task, signal) {
    const queue = resources[resource] || resources.light;
    return queue.run(task, signal);
}

function resourceState() {
    return Object.fromEntries(
        Object.entries(resources).map(([name, queue]) => [
            name,
            queue.state()
        ])
    );
}

module.exports = {
    runResource,
    resourceState
};
