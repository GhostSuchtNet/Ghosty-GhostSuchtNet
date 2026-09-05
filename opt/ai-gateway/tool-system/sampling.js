"use strict";

const PROFILES = {
    precise: {
        temperature: 0.20,
        top_p: 0.75,
        top_k: 20
    },

    school: {
        temperature: 0.30,
        top_p: 0.80,
        top_k: 20
    },

    normal: {
        temperature: 0.70,
        top_p: 0.85,
        top_k: 20
    },

    ideas: {
        temperature: 0.95,
        top_p: 0.95,
        top_k: 40
    },

    story: {
        temperature: 1.05,
        top_p: 0.97,
        top_k: 60
    }
};

function samplingFor(profile) {
    return {
        ...(PROFILES[profile] || PROFILES.normal)
    };
}

module.exports = {
    PROFILES,
    samplingFor
};
