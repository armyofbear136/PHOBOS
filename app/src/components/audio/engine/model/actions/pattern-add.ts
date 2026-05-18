/**
 * The MIT License (MIT)
 *
 * Igor Zinken 2016-2023 - https://www.igorski.nl
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
import type { Store } from "@engine/_shims/vuex";
import type { EffluxPatternOrder } from "@engine/model/types/pattern-order";
import PatternUtil from "@engine/utils/pattern-util";
import PatternOrderUtil from "@engine/utils/pattern-order-util";
import type { IUndoRedoState } from "@engine/model/factories/history-state-factory";
import PatternFactory from "@engine/model/factories/pattern-factory";
import type { EffluxState } from "@engine/services/daw-bridge";

export default function( store: Store<EffluxState>, insertAtEnd?: boolean ): IUndoRedoState {
    const song = store.state.song.activeSong;
    const {
          activeOrderIndex,
          activePatternIndex,
          amountOfSteps,
          useOrders,
    } = store.getters;

    const existingOrder = [ ...song.order ];
    let newPatternIndex: number;
    let newOrderIndex = insertAtEnd ? song.order.length : activeOrderIndex;
    let newOrder: EffluxPatternOrder;
    
    if ( useOrders ) {
        newPatternIndex = song.patterns.length; // when using orders, newest pattern is always inserted at the end
        if ( insertAtEnd ) {
            newOrder = existingOrder.concat( song.patterns.length );
        } else {
            newOrder = PatternOrderUtil.addPatternAtIndex( existingOrder, newOrderIndex + 1, newPatternIndex );
        }
    } else {
        newPatternIndex = insertAtEnd ? song.patterns.length : activePatternIndex + 1;
        newOrder = existingOrder.concat( song.patterns.length ); // order is always linear with patterns in this mode
    }
    
    const { commit } = store;

    // note we don't cache song.patterns but always reference it from the song as the
    // patterns list is effectively replaced by below actions

    function act(): void {
        const pattern = PatternFactory.create( amountOfSteps );
        
        commit( "replacePatterns", PatternUtil.addPatternAtIndex( song.patterns, newPatternIndex, amountOfSteps, pattern ));
        commit( "replacePatternOrder", newOrder );
        commit( "setActiveOrderIndex", newOrderIndex );
        commit( "setActivePatternIndex", newPatternIndex );
    }
    act(); // perform action

    return {
        undo(): void {
            commit( "replacePatterns", PatternUtil.removePatternAtIndex( song.patterns, newPatternIndex ));
            commit( "replacePatternOrder", existingOrder );
            commit( "setActiveOrderIndex", activeOrderIndex );
            commit( "setActivePatternIndex", activePatternIndex );
        },
        redo: act
    };
}