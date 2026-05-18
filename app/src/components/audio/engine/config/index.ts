/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2016-2022 - https://www.igorski.nl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
export default
{
    LOCAL_STORAGE_SONGS         : "effluxData",
    LOCAL_STORAGE_INSTRUMENTS   : "effluxInstruments",
    LOCAL_STORAGE_SETTINGS      : "effluxSettings",

    /**
     * Total length of song.instruments[] and session.channels[]. Index 0
     * is reserved by PhobosHost as the system chain (Helm + Crystal) and
     * is NEVER surfaced in the DAW UI — channel headers, pattern grid,
     * editor cursor, and the chain modal all skip index 0. Indices 1..8
     * are the user-facing "Instrument 1" through "Instrument 8". This
     * makes channelIndex literally equal to the user-visible instrument
     * number, eliminating off-by-one display logic across the codebase.
     */
    INSTRUMENT_AMOUNT           : 9,
    OSCILLATOR_AMOUNT           : 3,
    WAVE_TABLE_SIZE             : 512,
    MAX_PATTERN_AMOUNT          : 128,
    MAX_OCTAVE                  : 8,

    MIN_EQ_GAIN                 : -40.0, // in dB

    DEFAULT_FILTER_FREQ         : 880,
    DEFAULT_FILTER_Q            : 20,
    MAX_FILTER_FREQ             : 22050, // BiQuad filter max
    MAX_FILTER_Q                : 40,

    DEFAULT_FILTER_LFO_SPEED    : 0.5,
    DEFAULT_FILTER_LFO_DEPTH    : 50,
    MAX_FILTER_LFO_SPEED        : 25,
    MAX_FILTER_LFO_DEPTH        : 100,

    MAX_DELAY_CUTOFF            : 22050, // BiQuad filter max
    MIN_DELAY_OFFSET            : -0.5,
    MAX_DELAY_TIME              : 2, // in seconds (180 is max)

    JAM_MODE_PATTERN_AMOUNT     : 8,
};