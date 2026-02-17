// getCanonicalSequence: (moveSequence, numCols) => {
//    let mirrored = moveSequence.split('').map(col => (numCols - 1) - parseInt(col)).join('');
//    return moveSequence < mirrored ? moveSequence : mirrored;
// }
const { getCanonicalSequence } = require("./gameUtils");

console.log(getCanonicalSequence("3736589742477544335585222", 9));

console.log(getCanonicalSequence("8535535533966746664", 9));

console.log(getCanonicalSequence("5555566668923323688566565586889823322338829923322191199911119117747", 9));
console.log(getCanonicalSequence("4523333442565544673", 7));
console.log(getCanonicalSequence("44444453373327533777762221111112255", 7));
console.log(getCanonicalSequence("4544332134544331113252", 5));

//results
// 3736589742477544335585222
// 0353353355-122142224
// 3333322220-16556520032232330200-106556655006-1-1655667-177-1-1-17777-1771141
// 21433332241011220-13
// 222222133-1334-1133-1-1-1-104445555554411
// 1011223421011224442303